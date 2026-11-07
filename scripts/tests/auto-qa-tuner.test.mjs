import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    IMAGE_JOB,
    collectRuns,
    jobFailureRates,
    jsonLineDiff,
    main,
    measurementsFrom,
    parseMeasurement,
    percentile,
    propose,
    validateTuning,
} from '../auto-qa-tuner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const committed = () => JSON.parse(readFileSync(join(ROOT, '.github/auto-qa-tuning.json'), 'utf8'));

function tuning({ age = 3, retries = 2 } = {}) {
    return {
        nightly: {
            image_max_age_days: { value: age, min: 2, max: 7 },
            network_retries: { value: retries, min: 1, max: 5 },
        },
        rules: {
            window_runs: 20,
            min_runs: 7,
            age_percentile: 75,
            age_slack_days: 1,
            raise_retries_when_last_attempt_saves: 2,
            lower_retries_after_clean_runs: 14,
        },
    };
}

const op = (name, attempts, allowed = 3, result = 'ok') => ({ op: name, attempts, allowed, result });
const okOps = () => [op('inspect', 1), op('cosign-verify', 1), op('pull', 1)];
/** n runs, newest first, each with the given age and ops. */
function runs(n, { ageHours = 5, ops = okOps } = {}) {
    return Array.from({ length: n }, (_, i) => ({
        id: 100 - i,
        created_at: new Date(Date.UTC(2026, 10, 30 - i, 9, 41)).toISOString(),
        conclusion: 'success',
        jobs: [
            { name: 'Shellcheck', conclusion: 'success' },
            { name: IMAGE_JOB, conclusion: 'success' },
        ],
        ageHours: typeof ageHours === 'function' ? ageHours(i) : ageHours,
        ops: ops(i),
    }));
}

test('the committed tuning file is valid and inside its bounds', () => {
    assert.doesNotThrow(() => validateTuning(committed()));
});

test('validateTuning rejects out-of-bounds values and bad rules', () => {
    const t = tuning();
    t.nightly.network_retries.value = 9;
    assert.throws(() => validateTuning(t), /outside \[1, 5\]/);
    const u = tuning();
    u.rules.window_runs = 500;
    assert.throws(() => validateTuning(u), /at most 100/);
    const v = tuning();
    delete v.nightly.image_max_age_days.max;
    assert.throws(() => validateTuning(v), /integer value, min and max/);
});

test('annotations are parsed; other titles are ignored', () => {
    assert.deepEqual(parseMeasurement('op=pull attempts=2 allowed=3 result=ok'), {
        op: 'pull', attempts: '2', allowed: '3', result: 'ok',
    });
    const m = measurementsFrom([
        { title: 'auto-qa', message: 'image_age_hours=21' },
        { title: 'auto-qa', message: 'op=cosign-verify attempts=2 allowed=3 result=ok' },
        { title: 'something else', message: 'image_age_hours=999' },
        { title: 'auto-qa', message: 'op=pull attempts=x allowed=3' },
    ]);
    assert.deepEqual(m, { ageHours: 21, ops: [op('cosign-verify', 2)] });
});

test('nearest-rank percentile', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([1, 2, 3, 4], 75), 3);
    assert.equal(percentile([7], 90), 7);
    assert.equal(percentile([1, 2, 3], 100), 3);
});

test('too few measured runs: nothing is proposed', () => {
    const r = propose(tuning(), runs(6));
    assert.deepEqual(r.changes, []);
    assert.match(r.notes[0], /at least 7 are needed/);
    const unmeasured = runs(10, { ageHours: null, ops: () => [] });
    assert.deepEqual(propose(tuning(), unmeasured).changes, []);
});

test('retries go up when operations are saved only by the last allowed attempt', () => {
    const r = propose(tuning({ age: 2 }), runs(10, { ops: (i) => (i < 2 ? [op('pull', 3)] : okOps()) }));
    assert.deepEqual(r.changes.map((c) => [c.key, c.from, c.to]), [['network_retries', 2, 3]]);
    assert.equal(r.proposed.nightly.network_retries.value, 3);
});

test('a single last-attempt save, or a failure on every attempt, does not raise retries', () => {
    const one = propose(tuning({ age: 2 }), runs(10, { ops: (i) => (i === 0 ? [op('pull', 3)] : okOps()) }));
    assert.deepEqual(one.changes, []);
    const outage = propose(tuning({ age: 2 }), runs(10, { ops: (i) => (i < 4 ? [op('pull', 3, 3, 'failed')] : okOps()) }));
    assert.deepEqual(outage.changes, []);
    assert.match(outage.notes.join('\n'), /4 run\(s\) with an operation that failed every attempt/);
});

test('retries go down after enough clean runs, never below min, never above max', () => {
    const down = propose(tuning({ age: 2 }), runs(14));
    assert.deepEqual(down.changes.map((c) => [c.key, c.from, c.to]), [['network_retries', 2, 1]]);
    assert.deepEqual(propose(tuning({ age: 2, retries: 1 }), runs(14)).changes, []);
    const atMax = propose(tuning({ age: 2, retries: 5 }), runs(10, { ops: () => [op('pull', 6, 6)] }));
    assert.deepEqual(atMax.changes, []);
    // 13 clean runs is one short of the rule.
    assert.deepEqual(propose(tuning({ age: 2 }), runs(13)).changes, []);
});

test('staleness threshold moves one day toward p75 age plus slack, inside bounds', () => {
    // Healthy daily build: about 5 hours old at check time. Ideal 1 + 1 = 2.
    const tighten = propose(tuning({ age: 4 }), runs(10, { ops: () => [op('pull', 2)] }));
    assert.deepEqual(tighten.changes.map((c) => [c.key, c.from, c.to]), [['image_max_age_days', 4, 3]]);
    // Builds landing late: p75 age 40 hours. Ideal 2 + 1 = 3.
    const loosen = propose(tuning({ age: 2 }), runs(8, { ageHours: 40, ops: () => [op('pull', 2)] }));
    assert.deepEqual(loosen.changes.map((c) => [c.key, c.from, c.to]), [['image_max_age_days', 2, 3]]);
    // Never below min.
    assert.deepEqual(propose(tuning({ age: 2 }), runs(10, { ops: () => [op('pull', 2)] })).changes, []);
});

test('a short outage does not loosen the staleness threshold', () => {
    // Two of ten nights saw a very old image (failed builds); p75 is still healthy.
    const r = propose(tuning({ age: 2 }), runs(10, { ageHours: (i) => (i < 2 ? 120 : 5), ops: () => [op('pull', 2)] }));
    assert.deepEqual(r.changes, []);
});

test('job failure rates per job name', () => {
    const rs = runs(4);
    rs[0].jobs[1].conclusion = 'failure';
    rs[1].jobs[0].conclusion = 'skipped';
    assert.deepEqual(jobFailureRates(rs), [
        { name: IMAGE_JOB, runs: 4, failed: 1 },
        { name: 'Shellcheck', runs: 4, failed: 0 },
    ]);
});

test('jsonLineDiff shows only the changed lines', () => {
    const before = tuning();
    const after = structuredClone(before);
    after.nightly.network_retries.value = 3;
    assert.equal(jsonLineDiff(before, after), '-            "value": 2,\n+            "value": 3,');
});

/** Fake `gh` for collectRuns: the runs list, each run's jobs, each image job's annotations. */
function fakeGh(fixture) {
    return (args) => {
        const path = args[1].split('?')[0];
        if (path.endsWith('/actions/workflows/nightly-compliance.yml/runs')) return { workflow_runs: fixture.runs };
        let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(path);
        if (m) return { jobs: fixture.jobs[m[1]] };
        m = /\/check-runs\/(\d+)\/annotations$/.exec(path);
        if (m) return fixture.annotations[m[1]] ?? [];
        throw new Error(`unexpected gh call ${args.join(' ')}`);
    };
}

test('collectRuns keeps scheduled and dispatched runs and reads image job annotations', () => {
    const gh = fakeGh({
        runs: [
            { id: 1, event: 'schedule', created_at: '2026-11-01T09:41:00Z', conclusion: 'success' },
            { id: 2, event: 'push', created_at: '2026-11-02T09:41:00Z', conclusion: 'success' },
            { id: 3, event: 'workflow_dispatch', created_at: '2026-11-03T09:41:00Z', conclusion: 'failure' },
        ],
        jobs: {
            1: [{ name: IMAGE_JOB, conclusion: 'success', check_run_url: 'https://api.github.com/repos/Danathar/appbox/check-runs/11' }],
            3: [{ name: 'Shellcheck', conclusion: 'failure', check_run_url: 'https://api.github.com/repos/Danathar/appbox/check-runs/31' }],
        },
        annotations: { 11: [{ title: 'auto-qa', message: 'image_age_hours=6' }] },
    });
    const got = collectRuns(gh, 'Danathar/appbox', 20);
    assert.deepEqual(got.map((r) => r.id), [3, 1]);
    assert.equal(got[1].ageHours, 6);
    assert.equal(got[0].ageHours, null);
});

test('main writes the report and issue body, and sets changed= in GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-qa-'));
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github/auto-qa-tuning.json'), JSON.stringify(tuning({ age: 4 }), null, 4) + '\n');
    const out = join(dir, 'out');
    const ghOut = join(dir, 'gh-output');
    writeFileSync(ghOut, '');
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const gh = fakeGh({
        runs: ids.map((id) => ({ id, event: 'schedule', created_at: `2026-11-${String(id).padStart(2, '0')}T09:41:00Z`, conclusion: 'success' })),
        jobs: Object.fromEntries(ids.map((id) => [id, [{ name: IMAGE_JOB, conclusion: 'success', check_run_url: `x/check-runs/${id}` }]])),
        annotations: Object.fromEntries(
            ids.map((id) => [id, [
                { title: 'auto-qa', message: 'image_age_hours=5' },
                { title: 'auto-qa', message: 'op=pull attempts=2 allowed=3 result=ok' },
            ]])
        ),
    });
    const sink = { write: () => {} };
    const code = main(['--repo', 'Danathar/appbox', '--root', dir, '--out-dir', out], { gh, stdout: sink, stderr: sink, env: { GITHUB_OUTPUT: ghOut } });
    assert.equal(code, 0);
    assert.equal(readFileSync(ghOut, 'utf8'), 'changed=true\n');
    const body = readFileSync(join(out, 'issue-body.md'), 'utf8');
    assert.match(body, /\| image_max_age_days \| 4 \| 3 \|/);
    assert.match(body, /```diff\n- {12}"value": 4,\n\+ {12}"value": 3,/);
    assert.equal(JSON.parse(readFileSync(join(out, 'proposed.json'), 'utf8')).nightly.image_max_age_days.value, 3);
});

test('main exits 2 on a bad tuning file or bad arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-qa-'));
    mkdirSync(join(dir, '.github'));
    const bad = tuning();
    bad.nightly.image_max_age_days.value = 30;
    writeFileSync(join(dir, '.github/auto-qa-tuning.json'), JSON.stringify(bad));
    const sink = { write: () => {} };
    const io = { gh: () => { throw new Error('no network in tests'); }, stdout: sink, stderr: sink, env: {} };
    assert.equal(main(['--repo', 'Danathar/appbox', '--root', dir, '--out-dir', join(dir, 'o')], io), 2);
    assert.equal(main(['--root', dir], io), 2);
});
