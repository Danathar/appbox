#!/usr/bin/env node
/**
 * Weekly self-tuning of the nightly compliance check
 * (.github/workflows/auto-qa.yml; tests in scripts/tests/auto-qa-tuner.test.mjs).
 *
 * The nightly's image job (.github/workflows/nightly-compliance.yml) reads two
 * values from .github/auto-qa-tuning.json and records what it measured as
 * notice annotations titled `auto-qa`:
 *   image_age_hours=<n>                          age of ghcr.io/danathar/appbox:latest
 *   op=<name> attempts=<n> allowed=<m> result=ok|failed   one registry operation
 * This script reads those annotations back from the last rules.window_runs
 * completed nightly runs on main and proposes new values:
 *
 *   network_retries     +1 when, in at least raise_retries_when_last_attempt_saves
 *                       runs, some operation succeeded only on its final
 *                       allowed attempt (the retries were barely enough).
 *                       -1 when the most recent lower_retries_after_clean_runs
 *                       runs needed no retry at all.
 *   image_max_age_days  ceil(age_percentile of the observed ages, in days)
 *                       + age_slack_days, moved at most one day per run. A
 *                       percentile rather than the maximum, so an outage of a
 *                       few nights does not loosen the threshold.
 *
 * Every proposal is clamped to the value's own min and max in the JSON. With
 * fewer than rules.min_runs measured runs it proposes nothing. It never writes
 * the tuning file: it writes report.md, issue-body.md and proposed.json to
 * --out-dir, and the workflow puts the proposal in a tracking issue.
 *
 * It also reports each nightly job's failure rate over the window, for a
 * person deciding whether a check is flaky.
 *
 * Usage:
 *   node scripts/auto-qa-tuner.mjs --repo Danathar/appbox [--root .] [--out-dir auto-qa-out]
 * Reads GitHub through the `gh` CLI (GH_TOKEN in the environment).
 * Exit codes: 0 report written (with or without a proposal); 2 bad usage,
 * an invalid tuning file, or an API error.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NIGHTLY_WORKFLOW = 'nightly-compliance.yml';
export const IMAGE_JOB = 'Published image';
export const ANNOTATION_TITLE = 'auto-qa';
export const TUNABLES = ['image_max_age_days', 'network_retries'];

/** Throws unless every tunable has integer value/min/max with min <= value <= max, and rules are sane. */
export function validateTuning(tuning) {
    for (const key of TUNABLES) {
        const t = tuning?.nightly?.[key];
        if (!t || ![t.value, t.min, t.max].every(Number.isInteger)) {
            throw new Error(`nightly.${key} needs integer value, min and max`);
        }
        if (!(t.min <= t.value && t.value <= t.max)) {
            throw new Error(`nightly.${key}.value ${t.value} is outside [${t.min}, ${t.max}]`);
        }
    }
    const r = tuning.rules ?? {};
    const positive = ['window_runs', 'min_runs', 'raise_retries_when_last_attempt_saves', 'lower_retries_after_clean_runs'];
    for (const k of positive) {
        if (!Number.isInteger(r[k]) || r[k] < 1) throw new Error(`rules.${k} must be a positive integer`);
    }
    if (r.window_runs > 100) throw new Error('rules.window_runs must be at most 100');
    if (r.min_runs > r.window_runs || r.lower_retries_after_clean_runs > r.window_runs) {
        throw new Error('rules.min_runs and rules.lower_retries_after_clean_runs must not exceed rules.window_runs');
    }
    if (!(r.age_percentile > 0 && r.age_percentile <= 100)) throw new Error('rules.age_percentile must be in (0, 100]');
    if (!Number.isInteger(r.age_slack_days) || r.age_slack_days < 0) throw new Error('rules.age_slack_days must be a non-negative integer');
    return tuning;
}

/** Parses `key=value` pairs from one annotation message. */
export function parseMeasurement(message) {
    const out = {};
    for (const m of String(message ?? '').matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
    return out;
}

/**
 * One run's measurements from its image job's annotations.
 * @returns {{ageHours: number|null, ops: {op: string, attempts: number, allowed: number, result: string}[]}}
 */
export function measurementsFrom(annotations) {
    let ageHours = null;
    const ops = [];
    for (const a of annotations) {
        if (a.title !== ANNOTATION_TITLE) continue;
        const kv = parseMeasurement(a.message);
        if (kv.image_age_hours !== undefined && Number.isFinite(Number(kv.image_age_hours))) {
            ageHours = Number(kv.image_age_hours);
        }
        if (kv.op && Number.isInteger(Number(kv.attempts)) && Number.isInteger(Number(kv.allowed))) {
            ops.push({ op: kv.op, attempts: Number(kv.attempts), allowed: Number(kv.allowed), result: kv.result ?? 'unknown' });
        }
    }
    return { ageHours, ops };
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const clamp = (n, t) => Math.min(t.max, Math.max(t.min, n));

/**
 * @param {object} tuning the parsed .github/auto-qa-tuning.json
 * @param {{id: number, created_at: string, conclusion: string, jobs: {name: string, conclusion: string}[], ageHours: number|null, ops: object[]}[]} runs newest first
 */
export function propose(tuning, runs) {
    const rules = tuning.rules;
    const proposed = structuredClone(tuning);
    const changes = [];
    const notes = [];
    const measured = runs.filter((r) => r.ageHours !== null || r.ops.length > 0);

    if (measured.length < rules.min_runs) {
        notes.push(`Only ${measured.length} nightly run(s) in the window recorded measurements; at least ${rules.min_runs} are needed before anything is tuned.`);
        return { changes, proposed, notes, measured: measured.length };
    }

    // Registry retries.
    const retries = tuning.nightly.network_retries;
    const saves = measured.filter((r) => r.ops.some((o) => o.result === 'ok' && o.allowed > 1 && o.attempts === o.allowed)).length;
    const exhausted = measured.filter((r) => r.ops.some((o) => o.result === 'failed')).length;
    const recent = measured.slice(0, rules.lower_retries_after_clean_runs);
    const recentClean =
        recent.length === rules.lower_retries_after_clean_runs &&
        recent.every((r) => r.ops.length > 0 && r.ops.every((o) => o.attempts === 1));
    notes.push(
        `Registry operations: ${saves} run(s) saved only by the last allowed attempt, ${exhausted} run(s) with an operation that failed every attempt.`
    );
    let retriesTarget = retries.value;
    if (saves >= rules.raise_retries_when_last_attempt_saves) retriesTarget = retries.value + 1;
    else if (recentClean) retriesTarget = retries.value - 1;
    retriesTarget = clamp(retriesTarget, retries);
    if (retriesTarget !== retries.value) {
        const why =
            retriesTarget > retries.value
                ? `${saves} run(s) succeeded only on the last allowed attempt`
                : `the last ${rules.lower_retries_after_clean_runs} runs needed no retry`;
        changes.push({ key: 'network_retries', from: retries.value, to: retriesTarget, why });
        proposed.nightly.network_retries.value = retriesTarget;
    }

    // Image staleness threshold.
    const age = tuning.nightly.image_max_age_days;
    const ages = measured.map((r) => r.ageHours).filter((n) => n !== null);
    if (ages.length >= rules.min_runs) {
        const pAge = percentile(ages, rules.age_percentile);
        const ideal = Math.ceil(pAge / 24) + rules.age_slack_days;
        const step = Math.sign(ideal - age.value);
        const ageTarget = clamp(age.value + step, age);
        notes.push(
            `Image age: p${rules.age_percentile} ${pAge} hours over ${ages.length} run(s), so the ideal threshold is ${ideal} day(s).`
        );
        if (ageTarget !== age.value) {
            changes.push({
                key: 'image_max_age_days',
                from: age.value,
                to: ageTarget,
                why: `p${rules.age_percentile} image age ${pAge} h means an ideal of ${ideal} day(s); moved one day toward it`,
            });
            proposed.nightly.image_max_age_days.value = ageTarget;
        }
    } else {
        notes.push(`Only ${ages.length} run(s) recorded the image age; the staleness threshold is left alone.`);
    }

    return { changes, proposed, notes, measured: measured.length };
}

/** Failure rate per job name over the runs. */
export function jobFailureRates(runs) {
    const by = new Map();
    for (const run of runs) {
        for (const job of run.jobs) {
            const s = by.get(job.name) ?? { name: job.name, runs: 0, failed: 0 };
            s.runs += 1;
            if (job.conclusion !== 'success' && job.conclusion !== 'skipped') s.failed += 1;
            by.set(job.name, s);
        }
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Line diff of two JSON documents with identical shape. */
export function jsonLineDiff(before, after) {
    const a = JSON.stringify(before, null, 4).split('\n');
    const b = JSON.stringify(after, null, 4).split('\n');
    const out = [];
    a.forEach((line, i) => {
        if (line !== b[i]) out.push(`-${line}`, `+${b[i]}`);
    });
    return out.join('\n');
}

export function renderReport(result, runs, tuning) {
    const out = ['## Auto-QA: nightly compliance tuning', ''];
    out.push(`Read ${runs.length} completed nightly run(s) on main; ${result.measured} recorded measurements.`, '');
    for (const n of result.notes) out.push(`- ${n}`);
    out.push('');
    if (result.changes.length === 0) {
        out.push(
            `No change proposed. Current values: image_max_age_days ${tuning.nightly.image_max_age_days.value}, network_retries ${tuning.nightly.network_retries.value}.`
        );
    } else {
        out.push('| Value | Now | Proposed | Why |', '| --- | ---: | ---: | --- |');
        for (const c of result.changes) out.push(`| ${c.key} | ${c.from} | ${c.to} | ${c.why} |`);
    }
    const rates = jobFailureRates(runs);
    if (rates.length > 0) {
        out.push('', '| Nightly job | Runs | Failed | Failure rate |', '| --- | ---: | ---: | ---: |');
        for (const r of rates) out.push(`| ${r.name} | ${r.runs} | ${r.failed} | ${Math.round((100 * r.failed) / r.runs)}% |`);
    }
    return out.join('\n') + '\n';
}

export function realGh(args) {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Recent nightly runs on main with their jobs and the image job's measurements, newest first. */
export function collectRuns(gh, repo, windowRuns) {
    const list = gh([
        'api',
        `repos/${repo}/actions/workflows/${NIGHTLY_WORKFLOW}/runs?branch=main&status=completed&per_page=${windowRuns}`,
    ]);
    const runs = [];
    for (const run of list.workflow_runs ?? []) {
        if (run.event !== 'schedule' && run.event !== 'workflow_dispatch') continue;
        const jobs = gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]).jobs ?? [];
        let m = { ageHours: null, ops: [] };
        const image = jobs.find((j) => j.name === IMAGE_JOB);
        const checkRunId = /\/check-runs\/(\d+)$/.exec(image?.check_run_url ?? '')?.[1];
        if (checkRunId) {
            m = measurementsFrom(gh(['api', `repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100`]));
        }
        runs.push({
            id: run.id,
            created_at: run.created_at,
            conclusion: run.conclusion,
            jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })),
            ...m,
        });
    }
    return runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function parseArgs(argv) {
    const opts = { repo: null, root: '.', 'out-dir': 'auto-qa-out' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!['--repo', '--root', '--out-dir'].includes(a)) throw new Error(`unknown argument ${a}`);
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        opts[a.slice(2)] = argv[++i];
    }
    if (!opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('--repo owner/name is required');
    return opts;
}

/** Runs the CLI and returns the exit code. */
export function main(argv, { gh = realGh, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
    let opts, tuning, runs, result;
    try {
        opts = parseArgs(argv);
        tuning = validateTuning(JSON.parse(readFileSync(resolve(opts.root, '.github/auto-qa-tuning.json'), 'utf8')));
        runs = collectRuns(gh, opts.repo, tuning.rules.window_runs);
        result = propose(tuning, runs);
    } catch (err) {
        stderr.write(`auto-qa-tuner: ${err.message}\n`);
        return 2;
    }
    const report = renderReport(result, runs, tuning);
    const outDir = resolve(opts['out-dir']);
    mkdirSync(outDir, { recursive: true });
    const changed = result.changes.length > 0;
    const issueBody = changed
        ? report +
          '\nProposed change to `.github/auto-qa-tuning.json` (apply it in a pull request; this workflow never commits):\n\n```diff\n' +
          jsonLineDiff(tuning, result.proposed) +
          '\n```\n'
        : '';
    writeFileSync(resolve(outDir, 'report.md'), report);
    writeFileSync(resolve(outDir, 'issue-body.md'), issueBody);
    writeFileSync(resolve(outDir, 'proposed.json'), JSON.stringify(result.proposed, null, 4) + '\n');
    stdout.write(report);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${changed}\n`);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
