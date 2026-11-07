#!/usr/bin/env node
/**
 * Audit trail report for agent pull requests merged into Danathar/appbox.
 * Run monthly by .github/workflows/agent-audit.yml; tests in
 * scripts/tests/ai-audit-report.test.mjs (fixtures only, no network).
 *
 * appbox runs on a fully autonomous hive: agent pull requests merge on their
 * own once the required checks pass, on every risk tier. So "merged by a bot"
 * is the normal path and is not a finding. What this audit reads back instead
 * is whether each automatic merge kept the rules that make autonomy safe.
 *
 * An agent pull request is one that
 *   - was opened by the Hive GitHub App (`app/danathar-atomic-hive` in `gh`
 *     output, `danathar-atomic-hive[bot]` in REST output), or
 *   - carries a hive signature line (SIGNATURE_PREFIX followed by agent=...),
 *     or
 *   - says it was generated with Claude Code (the line Claude Code adds to
 *     pull request bodies, or a claude.ai/code session link).
 * Everything else (Renovate, a person) is counted but not audited.
 *
 * Findings, each of which fails the run:
 *   dco             a commit without a Signed-off-by trailer. Merge commits
 *                   (more than one parent, such as "Update branch") are
 *                   skipped: they carry no trailer and what they bring in was
 *                   audited when it merged.
 *   signature       a pull request opened by the Hive App without its hive
 *                   signature line.
 *   required-check  a check that main's ruleset requires was missing or not
 *                   green on the pull request's head commit when it merged,
 *                   judged from the results that existed at the merge time.
 *                   The required checks are read from the live ruleset
 *                   (GET /repos/{repo}/rules/branches/main). A check counts
 *                   only for pull requests merged after the ruleset that
 *                   requires it was created, so merges from before the rule
 *                   existed are not reported. With no required checks
 *                   configured, the report says so and this rule is skipped.
 *   hold            the pull request carried the `hold` label (the owner's
 *                   brake) at the moment it merged. Worked out from the
 *                   label and unlabel events, not from the current labels, so
 *                   removing the label after the merge does not hide it.
 *
 * Audit floor: rules can only be audited from the time they applied. appbox
 * had no DCO or hive rules before this audit was added, so the workflow
 * passes --floor, the commit time of the first commit on main that added
 * .github/workflows/agent-audit.yml. Pull requests merged before the floor are
 * left out, and the report says when the floor cut the window. A deliberate
 * look back (workflow_dispatch with an explicit `since`) runs without a floor.
 *
 * Usage:
 *   node scripts/ai-audit-report.mjs --repo Danathar/appbox --since YYYY-MM-DD
 *        [--floor <ISO 8601 time>] [--output report.md]
 * Reads GitHub through the `gh` CLI (GH_TOKEN in the environment).
 *
 * Exit codes: 0 no findings (including "no agent pull requests in the
 * window", which the report states plainly); 1 at least one finding; 2 bad
 * usage, an API error, or a list that may be truncated.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HIVE_APP_LOGINS = ['app/danathar-atomic-hive', 'danathar-atomic-hive[bot]'];
// The hive signature line starts with an em dash. Written as an escape so the
// character itself appears nowhere in this repository's files.
export const SIGNATURE_PREFIX = '\u2014 hive:';
export const HOLD_LABEL = 'hold';
export const PR_LIST_LIMIT = 500;
// GET /pulls/{n}/commits returns at most 250 commits.
export const COMMIT_CAP = 250;
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const CLAUDE_CODE_MARKER = /Generated with \[Claude Code\]|claude\.ai\/code\/session_/;

/** Body lines outside fenced code blocks, trimmed. Examples are not statements. */
export function unfencedLines(body) {
    const out = [];
    let fence = null;
    for (const raw of String(body ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        const open = /^(`{3,}|~{3,})(.*)$/.exec(line);
        if (open) {
            const [, marker, rest] = open;
            if (fence === null) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === '') fence = null;
            continue;
        }
        if (fence === null) out.push(line);
    }
    return out;
}

/** The first hive signature line naming an agent, or null. */
export function findSignature(body) {
    return (
        unfencedLines(body).find(
            (line) => line.startsWith(SIGNATURE_PREFIX) && /(^|\s)agent=\S+/.test(line)
        ) ?? null
    );
}

export function isHiveApp(user) {
    return HIVE_APP_LOGINS.includes(user?.login);
}

/** Why a pull request counts as agent-written, or null when it does not. */
export function classify(pr) {
    if (isHiveApp(pr?.author)) return 'hive-app';
    if (findSignature(pr?.body)) return 'hive-signature';
    if (CLAUDE_CODE_MARKER.test(String(pr?.body ?? ''))) return 'claude-code';
    return null;
}

/** Short SHAs of non-merge commits without a Signed-off-by trailer (REST commit objects). */
export function unsignedCommits(commits) {
    return commits
        .filter((c) => (c.parents ?? []).length <= 1)
        .filter((c) => !/^Signed-off-by:[ \t]*\S/m.test(c.commit?.message ?? ''))
        .map((c) => String(c.sha).slice(0, 7));
}

/**
 * Whether `label` was on the pull request at `mergedAt`, replaying its
 * labeled and unlabeled events (GET /issues/{n}/events) in time order.
 */
export function labelAtMerge(events, mergedAt, label = HOLD_LABEL) {
    const at = Date.parse(mergedAt);
    let on = false;
    const relevant = events
        .filter((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === label)
        .filter((e) => Date.parse(e.created_at) <= at)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const e of relevant) on = e.event === 'labeled';
    return on;
}

/**
 * Required checks that were not green on the head commit at the moment the
 * pull request merged. Only results that existed then count: a check run
 * completed after the merge, or a status posted after it, is ignored, so a
 * rerun after the merge can neither hide a violation nor invent one.
 * @param {{context: string, since: string}[]} required
 * @param {string} mergedAt
 * @param {object[]} checkRuns GET /commits/{sha}/check-runs?filter=all (every attempt)
 * @param {object[]} statuses GET /commits/{sha}/statuses (every status posted)
 * @returns {{context: string, state: string}[]}
 */
export function requiredCheckGaps(required, mergedAt, checkRuns, statuses) {
    const gaps = [];
    const at = Date.parse(mergedAt);
    const newestBefore = (items, stamp) =>
        items
            .filter((x) => x[stamp] && Date.parse(x[stamp]) <= at)
            .sort((a, b) => Date.parse(b[stamp]) - Date.parse(a[stamp]) || Number(b.id) - Number(a.id))[0];
    for (const req of required) {
        if (Date.parse(req.since) > at) continue;
        const run = newestBefore(checkRuns.filter((r) => r.name === req.context), 'completed_at');
        const status = newestBefore(statuses.filter((x) => x.context === req.context), 'created_at');
        if (!run && !status) {
            gaps.push({ context: req.context, state: 'missing (no result before the merge)' });
            continue;
        }
        const runOk = run !== undefined && PASSING_CONCLUSIONS.has(run.conclusion);
        const statusOk = status?.state === 'success';
        if (!runOk && !statusOk) gaps.push({ context: req.context, state: String(run ? run.conclusion : status.state) });
    }
    return gaps;
}

/** Findings for one agent pull request, as `{rule, detail}`. */
export function auditPr(pr, details, required) {
    const findings = [];
    const unsigned = unsignedCommits(details.commits);
    if (unsigned.length > 0) {
        findings.push({ rule: 'dco', detail: `commit(s) without Signed-off-by: ${unsigned.join(', ')}` });
    }
    if (isHiveApp(pr.author) && !findSignature(pr.body)) {
        findings.push({ rule: 'signature', detail: `opened by the Hive App without a "${SIGNATURE_PREFIX} agent=..." line` });
    }
    for (const gap of requiredCheckGaps(required, pr.mergedAt, details.checkRuns, details.statuses)) {
        findings.push({ rule: 'required-check', detail: `required check \`${gap.context}\` was ${gap.state} on the head commit` });
    }
    if (labelAtMerge(details.events, pr.mergedAt)) {
        findings.push({ rule: 'hold', detail: `merged while labeled \`${HOLD_LABEL}\`` });
    }
    return findings;
}

/**
 * Required status checks on main, each with the creation time of the ruleset
 * that requires it (earliest, when several do).
 */
export function requiredFromRules(rules, rulesetCreated) {
    const out = new Map();
    for (const rule of rules) {
        if (rule.type !== 'required_status_checks') continue;
        const since = rulesetCreated[rule.ruleset_id];
        if (!since) throw new Error(`no creation time for ruleset ${rule.ruleset_id}`);
        for (const check of rule.parameters?.required_status_checks ?? []) {
            const prev = out.get(check.context);
            if (!prev || Date.parse(since) < Date.parse(prev)) out.set(check.context, since);
        }
    }
    return [...out].map(([context, since]) => ({ context, since }));
}

/** Calls `gh` with the given arguments and parses its JSON output. */
export function realGh(args) {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out);
}

function paged(gh, path, pick, cap = Infinity) {
    const items = [];
    for (let page = 1; ; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const batch = pick(gh(['api', `${path}${sep}per_page=100&page=${page}`]));
        if (!Array.isArray(batch)) throw new Error(`unexpected response from ${path}`);
        items.push(...batch);
        if (items.length >= cap) throw new Error(`${path} reached ${cap} items; it cannot be audited in full`);
        if (batch.length < 100) return items;
    }
}

/**
 * True when a pull request merged inside the window: on or after `since`
 * (a date) and, when a floor is given, at or after the floor (a time).
 */
export function inWindow(pr, since, floor = null) {
    const mergedAt = pr?.mergedAt ?? '';
    if (mergedAt.slice(0, 10) < since) return false;
    return floor === null || Date.parse(mergedAt) >= Date.parse(floor);
}

/** Fetches everything the audit needs. All GitHub access goes through `gh`. */
export function collect(gh, repo, since, floor = null) {
    const prs = gh([
        'pr', 'list', '--repo', repo, '--state', 'merged',
        '--limit', String(PR_LIST_LIMIT), '--search', `merged:>=${since}`,
        '--json', 'number,title,author,body,mergedAt,mergedBy,url,baseRefName,headRefOid',
    ]);
    if (!Array.isArray(prs)) throw new Error('gh pr list did not return a list');
    if (prs.length >= PR_LIST_LIMIT) {
        throw new Error(`${prs.length} merged pull requests reached the ${PR_LIST_LIMIT} limit; audit a narrower window`);
    }
    const rules = gh(['api', `repos/${repo}/rules/branches/main`]);
    const created = {};
    for (const rule of rules) {
        if (rule.type === 'required_status_checks' && !(rule.ruleset_id in created)) {
            created[rule.ruleset_id] = gh(['api', `repos/${repo}/rulesets/${rule.ruleset_id}`]).created_at;
        }
    }
    const required = requiredFromRules(rules, created);
    const details = {};
    for (const pr of prs) {
        if (!classify(pr) || !inWindow(pr, since, floor)) continue;
        const sha = pr.headRefOid;
        details[pr.number] = {
            commits: paged(gh, `repos/${repo}/pulls/${pr.number}/commits`, (x) => x, COMMIT_CAP),
            events: paged(gh, `repos/${repo}/issues/${pr.number}/events`, (x) => x),
            checkRuns: paged(gh, `repos/${repo}/commits/${sha}/check-runs?filter=all`, (x) => x.check_runs),
            statuses: paged(gh, `repos/${repo}/commits/${sha}/statuses`, (x) => x),
        };
    }
    return { prs, required, details };
}

export function buildReport({ prs, required, details }, since, floor = null) {
    const afterSince = prs.filter((pr) => inWindow(pr, since));
    const audited = afterSince.filter((pr) => inWindow(pr, since, floor));
    const rows = [];
    for (const pr of audited) {
        const kind = classify(pr);
        if (!kind) continue;
        rows.push({
            number: pr.number,
            title: pr.title ?? '',
            url: pr.url ?? '',
            kind,
            author: pr.author?.login ?? 'unknown',
            mergedBy: pr.mergedBy?.login ?? 'unknown',
            merged: (pr.mergedAt ?? '').slice(0, 10),
            findings: auditPr(pr, details[pr.number], required),
        });
    }
    return {
        since,
        floor,
        floorCut: floor !== null && Date.parse(floor) > Date.parse(`${since}T00:00:00Z`),
        beforeFloor: afterSince.length - audited.length,
        total: audited.length,
        rows,
        required,
        findingCount: rows.reduce((n, r) => n + r.findings.length, 0),
    };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(report) {
    const out = [
        `### Agent audit trail: pull requests merged since ${report.since}`,
        '',
        `${report.total} pull request(s) merged in the window; ${report.rows.length} written by an agent and audited.`,
        '',
    ];
    if (report.floorCut) {
        out.push(
            `**The audit floor cut the window.** This audit started applying at ${report.floor} (the first commit on \`main\` that added \`.github/workflows/agent-audit.yml\`), which is later than ${report.since}, so the window starts there. ${report.beforeFloor} pull request(s) merged after ${report.since} but before the floor were not audited. Run the workflow by hand with an explicit \`since\` to look further back.`,
            ''
        );
    }
    if (report.required.length === 0) {
        out.push('No required status checks are configured on `main`, so the required-check rule was skipped.', '');
    } else {
        out.push(
            `Required checks on \`main\`: ${report.required.map((r) => `\`${r.context}\` (since ${r.since.slice(0, 10)})`).join(', ')}.`,
            ''
        );
    }
    if (report.rows.length === 0) {
        out.push(
            '**No agent pull requests were merged in the window, so nothing was audited.** That is not evidence of compliance; the hive may be paused.',
            ''
        );
        return out.join('\n');
    }
    out.push(
        '| PR | Merged | Agent mark | Author | Merged by | Result |',
        '| --- | --- | --- | --- | --- | --- |'
    );
    for (const r of report.rows) {
        const result = r.findings.length === 0 ? 'ok' : r.findings.map((f) => `${f.rule}: ${f.detail}`).join('; ');
        out.push(
            `| [#${r.number}](${r.url}) ${cell(r.title)} | ${r.merged} | ${r.kind} | ${cell(r.author)} | ${cell(r.mergedBy)} | ${cell(result)} |`
        );
    }
    out.push(
        '',
        report.findingCount === 0
            ? 'Every audited agent pull request kept the rules: signed-off commits, a hive signature line on Hive App pull requests, required checks green at merge, and no merge under the `hold` label.'
            : `${report.findingCount} finding(s) in ${report.rows.filter((r) => r.findings.length > 0).length} pull request(s).`,
        ''
    );
    return out.join('\n');
}

/** YYYY-MM-DD that round-trips, so 2026-02-30 is rejected rather than read as March. */
export function isRealDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseArgs(argv) {
    const opts = { repo: null, since: null, floor: null, output: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!['--repo', '--since', '--floor', '--output'].includes(a)) throw new Error(`unknown argument ${a}`);
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        opts[a.slice(2)] = argv[++i];
    }
    if (!opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('--repo owner/name is required');
    if (!opts.since || !isRealDate(opts.since)) throw new Error('--since must be a real date, YYYY-MM-DD');
    if (opts.floor !== null && !/^\d{4}-\d{2}-\d{2}T/.test(opts.floor)) throw new Error('--floor must be an ISO 8601 time');
    if (opts.floor !== null && Number.isNaN(Date.parse(opts.floor))) throw new Error('--floor must be an ISO 8601 time');
    return opts;
}

/** Runs the CLI and returns the exit code. */
export function main(argv, { gh = realGh, write = writeFileSync, stdout = process.stdout, stderr = process.stderr } = {}) {
    let report;
    let opts;
    try {
        opts = parseArgs(argv);
        report = buildReport(collect(gh, opts.repo, opts.since, opts.floor), opts.since, opts.floor);
    } catch (err) {
        stderr.write(`ai-audit-report: ${err.message}\n`);
        return 2;
    }
    const md = renderMarkdown(report);
    if (opts.output) write(opts.output, md);
    else stdout.write(md + '\n');
    return report.findingCount > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
