import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SIGNATURE_PREFIX,
    auditPr,
    buildReport,
    classify,
    collect,
    findSignature,
    isRealDate,
    labelAtMerge,
    main,
    parseArgs,
    renderMarkdown,
    requiredCheckGaps,
    requiredFromRules,
    unsignedCommits,
} from '../ai-audit-report.mjs';

const REPO = 'Danathar/appbox';
const SIG = `${SIGNATURE_PREFIX} agent=scanner backend=claude model=opus`;
const HEAD = 'a'.repeat(40);

function pr(overrides = {}) {
    return {
        number: 7,
        title: 'tests: cover the guarded-app path',
        author: { login: 'app/danathar-atomic-hive', is_bot: true },
        body: `Fixes #3\n\nBody.\n\n${SIG}`,
        mergedAt: '2026-11-20T10:00:00Z',
        mergedBy: { login: 'app/danathar-atomic-hive', is_bot: true },
        url: `https://github.com/${REPO}/pull/7`,
        baseRefName: 'main',
        headRefOid: HEAD,
        ...overrides,
    };
}

const commit = (sha, message, parents = 1) => ({
    sha,
    commit: { message },
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
});
const SIGNED = 'Add a test\n\nSigned-off-by: scanner <scanner@example.invalid>';

function details(overrides = {}) {
    return {
        commits: [commit('1111111aaaa', SIGNED)],
        events: [],
        checkRuns: [{ id: 10, name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-11-20T09:30:00Z' }],
        statuses: [],
        ...overrides,
    };
}

const REQUIRED = [{ context: 'test', since: '2026-11-10T00:00:00Z' }];

test('a clean hive pull request merged by the Hive App has no findings', () => {
    assert.deepEqual(auditPr(pr(), details(), REQUIRED), []);
});

test('classify: Hive App author, signature line, Claude Code marker, or nothing', () => {
    assert.equal(classify(pr()), 'hive-app');
    assert.equal(classify(pr({ author: { login: 'danathar-atomic-hive[bot]' } })), 'hive-app');
    assert.equal(classify(pr({ author: { login: 'Danathar' } })), 'hive-signature');
    assert.equal(
        classify(pr({ author: { login: 'Danathar' }, body: 'Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' })),
        'claude-code'
    );
    assert.equal(classify(pr({ author: { login: 'Danathar' }, body: 'https://claude.ai/code/session_abc' })), 'claude-code');
    assert.equal(classify(pr({ author: { login: 'app/renovate', is_bot: true }, body: 'Update docker/login-action' })), null);
});

test('a signature inside a code fence or without agent= is not a signature', () => {
    assert.equal(findSignature('```\n' + SIG + '\n```'), null);
    assert.equal(findSignature(`${SIGNATURE_PREFIX} nothing here`), null);
    assert.equal(findSignature(`text\n  ${SIG}  \n`), SIG);
});

test('a Hive App pull request without the signature line is a finding; a Claude Code one is not', () => {
    const f = auditPr(pr({ body: 'Fixes #3' }), details(), REQUIRED);
    assert.deepEqual(f.map((x) => x.rule), ['signature']);
    const human = pr({ author: { login: 'Danathar' }, body: 'Generated with [Claude Code](x)' });
    assert.deepEqual(auditPr(human, details(), REQUIRED), []);
});

test('unsigned commits are findings, merge commits are skipped', () => {
    const commits = [
        commit('1111111aaaa', SIGNED),
        commit('2222222bbbb', 'Fix typo'),
        commit('3333333cccc', "Merge branch 'main' into feature", 2),
        commit('4444444dddd', 'Mentions Signed-off-by: in prose only'),
    ];
    assert.deepEqual(unsignedCommits(commits), ['2222222', '4444444']);
    const f = auditPr(pr(), details({ commits }), REQUIRED);
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'dco');
    assert.match(f[0].detail, /2222222, 4444444/);
});

const BEFORE = '2026-11-20T09:30:00Z';
const AFTER = '2026-11-20T11:00:00Z';
const run = (id, conclusion, completed_at = BEFORE) => ({ id, name: 'test', status: 'completed', conclusion, completed_at });

test('required check missing, failing, or green on the head commit at merge time', () => {
    const at = '2026-11-20T10:00:00Z';
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [], []), [{ context: 'test', state: 'missing (no result before the merge)' }]);
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'failure')], []), [{ context: 'test', state: 'failure' }]);
    // Still running at merge: no completed result existed.
    assert.deepEqual(
        requiredCheckGaps(REQUIRED, at, [{ id: 1, name: 'test', status: 'in_progress', conclusion: null, completed_at: null }], []),
        [{ context: 'test', state: 'missing (no result before the merge)' }]
    );
    // The newest result before the merge decides: a passing re-run clears an older failure.
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'failure', '2026-11-20T09:00:00Z'), run(2, 'success')], []), []);
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [], [{ context: 'test', state: 'success', created_at: BEFORE }]), []);
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'skipped')], []), []);
});

test('results that arrived after the merge neither hide nor invent a violation', () => {
    const at = '2026-11-20T10:00:00Z';
    // Failed at merge, passed on a re-run afterwards: still a finding.
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'failure'), run(2, 'success', AFTER)], []), [
        { context: 'test', state: 'failure' },
    ]);
    // Green at merge, failed on a re-run afterwards: not a finding.
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'success'), run(2, 'failure', AFTER)], []), []);
    // Only a post-merge result: missing at merge time.
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [run(1, 'success', AFTER)], []), [
        { context: 'test', state: 'missing (no result before the merge)' },
    ]);
    // Commit statuses follow the same rule.
    const statuses = [
        { context: 'test', state: 'failure', created_at: BEFORE },
        { context: 'test', state: 'success', created_at: AFTER },
    ];
    assert.deepEqual(requiredCheckGaps(REQUIRED, at, [], statuses), [{ context: 'test', state: 'failure' }]);
});

test('a pull request merged before the ruleset required the check is not held to it', () => {
    assert.deepEqual(requiredCheckGaps(REQUIRED, '2026-11-09T23:59:59Z', [], []), []);
    const f = auditPr(pr({ mergedAt: '2026-11-01T00:00:00Z' }), details({ checkRuns: [] }), REQUIRED);
    assert.deepEqual(f, []);
});

test('hold label state is replayed from events at the merge time', () => {
    const merged = '2026-11-20T10:00:00Z';
    const ev = (event, name, at) => ({ event, label: { name }, created_at: at });
    assert.equal(labelAtMerge([ev('labeled', 'hold', '2026-11-19T00:00:00Z')], merged), true);
    assert.equal(
        labelAtMerge([ev('labeled', 'hold', '2026-11-19T00:00:00Z'), ev('unlabeled', 'hold', '2026-11-19T05:00:00Z')], merged),
        false
    );
    // Added after the merge, or a different label: not a finding.
    assert.equal(labelAtMerge([ev('labeled', 'hold', '2026-11-21T00:00:00Z')], merged), false);
    assert.equal(labelAtMerge([ev('labeled', 'hold-ci', '2026-11-19T00:00:00Z')], merged), false);
    // Removed after the merge still counts: the label was on when it merged.
    const removedLater = [ev('labeled', 'hold', '2026-11-19T00:00:00Z'), ev('unlabeled', 'hold', '2026-11-21T00:00:00Z')];
    const f = auditPr(pr(), details({ events: removedLater }), REQUIRED);
    assert.deepEqual(f.map((x) => x.rule), ['hold']);
});

test('requiredFromRules keeps the earliest ruleset creation time per check', () => {
    const rules = [
        { type: 'pull_request', ruleset_id: 1 },
        { type: 'required_status_checks', ruleset_id: 2, parameters: { required_status_checks: [{ context: 'test' }] } },
        { type: 'required_status_checks', ruleset_id: 3, parameters: { required_status_checks: [{ context: 'test' }, { context: 'Policy check' }] } },
    ];
    const got = requiredFromRules(rules, { 2: '2026-11-12T00:00:00Z', 3: '2026-11-10T00:00:00Z' });
    assert.deepEqual(got, [
        { context: 'test', since: '2026-11-10T00:00:00Z' },
        { context: 'Policy check', since: '2026-11-10T00:00:00Z' },
    ]);
    assert.throws(() => requiredFromRules(rules, {}), /no creation time/);
});

test('parseArgs validates repo and date', () => {
    assert.deepEqual(parseArgs(['--repo', REPO, '--since', '2026-11-01']), { repo: REPO, since: '2026-11-01', output: null });
    assert.throws(() => parseArgs(['--repo', REPO, '--since', '2026-02-30']), /real date/);
    assert.throws(() => parseArgs(['--since', '2026-11-01']), /--repo/);
    assert.throws(() => parseArgs(['--repo', REPO, '--since', '2026-11-01', '--bogus', 'x']), /unknown/);
    assert.equal(isRealDate('2026-11-31'), false);
});

/** A fake `gh` serving fixtures by path, ignoring per_page/page on page 1. */
function fakeGh({ prs, rules = [], rulesets = {}, perPr = {} }) {
    const calls = [];
    const gh = (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'pr') return prs;
        const [path, query = ''] = args[1].split('?');
        if (/(^|&)page=([2-9]|\d\d)/.test(query)) return path.endsWith('check-runs') ? { check_runs: [] } : [];
        if (path === `repos/${REPO}/rules/branches/main`) return rules;
        let m = /^repos\/[^/]+\/[^/]+\/rulesets\/(\d+)$/.exec(path);
        if (m) return { id: Number(m[1]), created_at: rulesets[m[1]] };
        m = /\/pulls\/(\d+)\/commits$/.exec(path);
        if (m) return perPr[m[1]].commits;
        m = /\/issues\/(\d+)\/events$/.exec(path);
        if (m) return perPr[m[1]].events;
        m = /\/commits\/([0-9a-f]+)\/check-runs$/.exec(path);
        if (m) return { check_runs: Object.values(perPr).find((d) => d.sha === m[1]).checkRuns };
        m = /\/commits\/([0-9a-f]+)\/statuses$/.exec(path);
        if (m) return [];
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    return { gh, calls };
}

const testRules = [{ type: 'required_status_checks', ruleset_id: 9, parameters: { required_status_checks: [{ context: 'test' }] } }];

test('collect only fetches details for agent pull requests', () => {
    const renovate = pr({ number: 8, author: { login: 'app/renovate', is_bot: true }, body: 'deps' });
    const { gh, calls } = fakeGh({
        prs: [pr(), renovate],
        rules: testRules,
        rulesets: { 9: '2026-11-10T00:00:00Z' },
        perPr: { 7: { sha: HEAD, ...details() } },
    });
    const data = collect(gh, REPO, '2026-11-01');
    assert.deepEqual(Object.keys(data.details), ['7']);
    assert.deepEqual(data.required, [{ context: 'test', since: '2026-11-10T00:00:00Z' }]);
    assert.ok(!calls.some((c) => c.includes('/pulls/8/')));
    // Every check-run attempt and every status, so results can be judged at merge time.
    assert.ok(calls.some((c) => c.includes(`/commits/${HEAD}/check-runs?filter=all&`)));
    assert.ok(calls.some((c) => c.includes(`/commits/${HEAD}/statuses?`)));
});

test('main exits 0 with no findings, 1 with findings, 2 on bad input', () => {
    const out = [];
    const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
    const clean = fakeGh({
        prs: [pr()],
        rules: testRules,
        rulesets: { 9: '2026-11-10T00:00:00Z' },
        perPr: { 7: { sha: HEAD, ...details() } },
    });
    assert.equal(main(['--repo', REPO, '--since', '2026-11-01'], { gh: clean.gh, ...io }), 0);
    assert.match(out.join(''), /Every audited agent pull request kept the rules/);

    out.length = 0;
    const red = fakeGh({
        prs: [pr()],
        rules: testRules,
        rulesets: { 9: '2026-11-10T00:00:00Z' },
        perPr: { 7: { sha: HEAD, ...details({ checkRuns: [{ id: 1, name: 'test', conclusion: 'failure', completed_at: '2026-11-20T09:30:00Z' }] }) } },
    });
    assert.equal(main(['--repo', REPO, '--since', '2026-11-01'], { gh: red.gh, ...io }), 1);
    assert.match(out.join(''), /required-check: required check `test` was failure/);

    out.length = 0;
    const many = fakeGh({ prs: Array.from({ length: 500 }, (_, i) => pr({ number: i + 1 })) });
    assert.equal(main(['--repo', REPO, '--since', '2026-11-01'], { gh: many.gh, ...io }), 2);
    assert.match(out.join(''), /500 limit/);

    assert.equal(main(['--since', 'yesterday'], { gh: clean.gh, ...io }), 2);
});

test('an empty window is reported as nothing audited, not as a pass', () => {
    const report = buildReport({ prs: [], required: [], details: {} }, '2026-11-01');
    const md = renderMarkdown(report);
    assert.match(md, /nothing was audited/);
    assert.match(md, /No required status checks are configured/);
    assert.equal(report.findingCount, 0);
});

test('pull requests merged before --since are not audited', () => {
    const old = pr({ mergedAt: '2026-10-01T00:00:00Z' });
    const report = buildReport({ prs: [old], required: REQUIRED, details: {} }, '2026-11-01');
    assert.equal(report.rows.length, 0);
    assert.equal(report.total, 0);
});

test('report cells escape pipes in titles', () => {
    const report = buildReport(
        { prs: [pr({ title: 'a | b' })], required: REQUIRED, details: { 7: details() } },
        '2026-11-01'
    );
    assert.match(renderMarkdown(report), /a \\\| b/);
});
