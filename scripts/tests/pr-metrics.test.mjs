// Tests for scripts/pr-metrics.mjs. Fixture data only; no network.
// Run: node --test scripts/tests/pr-metrics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    classifyMerger,
    classifyPr,
    computeMetrics,
    fetchPullRequests,
    findFollowUps,
    formatDuration,
    isFollowUpOf,
    median,
    normalizePr,
    parseArgs,
    percentile,
    renderMarkdown,
    table,
    toSavedInput,
} from '../pr-metrics.mjs';

const SCRIPT = fileURLToPath(new URL('../pr-metrics.mjs', import.meta.url));
const NOW = '2026-11-07T12:00:00Z';
const nowMs = Date.parse(NOW);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// Accounts in the three shapes the script accepts.
const owner = { login: 'Danathar', is_bot: false }; // gh pr list
const hiveGh = { login: 'app/danathar-atomic-hive', is_bot: true }; // gh pr list
const hiveGql = { login: 'danathar-atomic-hive', __typename: 'Bot' }; // GraphQL
const renovate = { login: 'app/renovate', is_bot: true };
const dependabotRest = { login: 'dependabot[bot]', type: 'Bot' }; // REST
const actions = { login: 'github-actions[bot]', type: 'Bot' };
const stranger = { login: 'someone', is_bot: false };
const CLAUDE_FOOTER = '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';

function pr(number, author, { createdAgo, mergedAfter, closedAfter, body = '', title = `PR ${number}`, mergedBy = owner, labels = [] }) {
    const created = nowMs - createdAgo;
    const p = { number, title, body, author, labels, createdAt: iso(created), mergedAt: null, closedAt: null, state: 'OPEN', mergedBy: null };
    if (mergedAfter !== undefined) {
        Object.assign(p, { state: 'MERGED', mergedAt: iso(created + mergedAfter), closedAt: iso(created + mergedAfter), mergedBy });
    } else if (closedAfter !== undefined) {
        Object.assign(p, { state: 'CLOSED', closedAt: iso(created + closedAfter) });
    }
    return p;
}

test('classifies authors: agent apps, Claude Code marker, dependency bots, humans', () => {
    const c = (author, extra = {}) => classifyPr(normalizePr({ number: 1, author, body: '', ...extra }));
    assert.equal(c(hiveGh), 'agent');
    assert.equal(c(hiveGql), 'agent');
    assert.equal(c({ login: 'claude[bot]', type: 'Bot' }), 'agent');
    assert.equal(c(owner, { body: `Change.${CLAUDE_FOOTER}` }), 'agent', 'local Claude Code session under the owner');
    assert.equal(c(actions, { body: `Fix.${CLAUDE_FOOTER}` }), 'agent', 'claude.yml / ai-fix.yml PR');
    assert.equal(c(owner, { labels: [{ name: 'ai-generated' }] }), 'agent');
    assert.equal(c(renovate), 'dependency-bot');
    assert.equal(c(dependabotRest), 'dependency-bot');
    assert.equal(c(actions), 'other-bot');
    assert.equal(c(owner), 'human');
    assert.equal(c(stranger), 'human');
    assert.equal(c(null), 'human', 'deleted account (ghost) has a null author');
});

test('renovate PRs that mention Claude stay dependency bots', () => {
    const p = normalizePr({ number: 2, author: renovate, body: 'Update anthropics/claude-code-action. Generated with [Claude Code]' });
    assert.equal(classifyPr(p), 'dependency-bot');
});

test('classifies who merged', () => {
    const n = (a) => normalizePr({ number: 1, author: owner, mergedBy: a }).mergedBy;
    assert.equal(classifyMerger(n(hiveGh)), 'hive');
    assert.equal(classifyMerger(n(owner)), 'owner');
    assert.equal(classifyMerger(n({ login: 'danathar', is_bot: false })), 'owner', 'case-insensitive');
    assert.equal(classifyMerger(n(stranger)), 'other-human');
    assert.equal(classifyMerger(n(renovate)), 'bot');
    assert.equal(classifyMerger(null), null);
});

test('normalizes REST, gh and GraphQL shapes to the same record', () => {
    const rest = normalizePr({ number: 5, title: 't', body: null, state: 'closed', user: dependabotRest, created_at: NOW, merged_at: NOW, closed_at: NOW, labels: [{ name: 'deps' }] });
    const gql = normalizePr({ number: 5, title: 't', body: '', state: 'MERGED', author: { login: 'dependabot', __typename: 'Bot' }, createdAt: NOW, mergedAt: NOW, closedAt: NOW, labels: { nodes: [{ name: 'deps' }] } });
    assert.deepEqual(rest, gql);
    assert.equal(rest.state, 'MERGED');
});

test('no PRs gives zeros and null rates, never NaN', () => {
    const m = computeMetrics([], { now: NOW });
    const s = m.windows.all.overall;
    assert.equal(s.merged, 0);
    assert.equal(s.acceptanceRate, null);
    assert.equal(s.timeToMergeHours.median, null);
    assert.equal(s.followUp.share, null);
    assert.doesNotMatch(renderMarkdown(m), /NaN/);
    assert.match(renderMarkdown(m), /n\/a/);
});

test('counts opened, merged, closed unmerged and open per class and window', () => {
    const prs = [
        pr(1, hiveGh, { createdAgo: 2 * DAY, mergedAfter: 2 * HOUR, mergedBy: hiveGh }),
        pr(2, hiveGh, { createdAgo: 3 * DAY, closedAfter: HOUR }),
        pr(3, hiveGh, { createdAgo: DAY }),
        pr(4, owner, { createdAgo: 60 * DAY, mergedAfter: 50 * DAY }), // opened before the window, merged inside it
        pr(5, renovate, { createdAgo: 90 * DAY, mergedAfter: HOUR, mergedBy: hiveGh }), // all outside the window
    ];
    const m = computeMetrics(prs, { now: NOW, windowDays: 30 });
    const recent = m.windows.last30d;
    assert.deepEqual(m.prsByClass, { agent: [1, 2, 3], human: [4], 'dependency-bot': [5], 'other-bot': [] });

    const agent = recent.byAuthorClass.agent;
    assert.equal(agent.opened, 3);
    assert.equal(agent.merged, 1);
    assert.equal(agent.closedUnmerged, 1);
    assert.equal(agent.open, 1);
    assert.equal(agent.acceptanceRate, 0.5);
    assert.equal(agent.mergedBy.hive, 1);

    const human = recent.byAuthorClass.human;
    assert.equal(human.opened, 0, 'opened 60 days ago');
    assert.equal(human.merged, 1, 'merged 10 days ago');
    assert.equal(human.timeToMergeHours.median, 50 * 24);

    assert.equal(recent.byAuthorClass['dependency-bot'].merged, 0);
    assert.equal(m.windows.all.byAuthorClass['dependency-bot'].merged, 1);
    assert.equal(m.windows.all.overall.merged, 3);
    assert.equal(m.windows.all.overall.mergedBy.hive, 2);
});

test('a PR decided after --now counts as open at that time', () => {
    const prs = [pr(1, owner, { createdAgo: DAY, mergedAfter: 2 * DAY })]; // merged tomorrow
    const s = computeMetrics(prs, { now: NOW }).windows.all.overall;
    assert.equal(s.merged, 0);
    assert.equal(s.open, 1);
});

test('median and nearest-rank p90', () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(percentile([], 90), null);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([5], 90), 5);
});

test('follow-up detection: references with a fix word, and GitHub reverts', () => {
    const base = normalizePr({ number: 12, title: 'Add the nudge', author: hiveGh });
    const later = (title, body = '') => normalizePr({ number: 20, title, body, author: owner });
    assert.ok(isFollowUpOf(later('Fix the nudge from #12'), base));
    assert.ok(isFollowUpOf(later('Tidy', 'Follow-up to #12: the timer was wrong.'), base));
    assert.ok(isFollowUpOf(later('Revert "Add the nudge"'), base));
    assert.ok(isFollowUpOf(later('Restore update', '#12 broke self-update'), base));
    assert.ok(!isFollowUpOf(later('Docs', 'See #12 for background.'), base), 'no fix word');
    assert.ok(!isFollowUpOf(later('Fix #123'), base), '#123 is not #12');
    assert.ok(!isFollowUpOf(later('Fix the timer', 'Mentions #12.\nFixes #30'), base), 'fix word on another line');
    assert.ok(!isFollowUpOf(base, base), 'a PR is not its own follow-up');
});

test('follow-up share for agent PRs counts merged fixes within the follow-up window', () => {
    const prs = [
        pr(10, hiveGh, { createdAgo: 20 * DAY, mergedAfter: HOUR, title: 'Add A' }),
        pr(11, hiveGh, { createdAgo: 19 * DAY, mergedAfter: HOUR, title: 'Add B' }),
        pr(12, hiveGh, { createdAgo: 18 * DAY, mergedAfter: HOUR, title: 'Add C' }),
        pr(13, hiveGh, { createdAgo: 17 * DAY, mergedAfter: HOUR, title: 'Add D' }),
        pr(20, owner, { createdAgo: 15 * DAY, mergedAfter: HOUR, title: 'Fix regression from #10' }), // counts, by a human
        pr(21, hiveGh, { createdAgo: 14 * DAY, mergedAfter: HOUR, title: 'Revert "Add B"' }), // counts, by an agent
        pr(22, owner, { createdAgo: 10 * DAY, closedAfter: HOUR, title: 'Fix #12' }), // not merged: ignored
        pr(23, owner, { createdAgo: DAY, mergedAfter: HOUR, title: 'Fix #13' }), // 16 days after: past the 14-day limit
    ];
    const followUps = findFollowUps(prs.map(normalizePr), { nowMs, followUpDays: 14 });
    assert.equal(followUps.get(10), 20);
    assert.equal(followUps.get(11), 21);
    assert.equal(followUps.get(12), null);
    assert.equal(followUps.get(13), null);

    const agent = computeMetrics(prs, { now: NOW }).windows.last30d.byAuthorClass.agent;
    assert.equal(agent.merged, 5, '10-13 and the revert 21');
    assert.equal(agent.followUp.needed, 2);
    assert.equal(agent.followUp.share, 2 / 5);
    assert.deepEqual(agent.followUp.prs, [{ pr: 10, fixedBy: 20 }, { pr: 11, fixedBy: 21 }]);
    const md = renderMarkdown(computeMetrics(prs, { now: NOW }));
    assert.match(md, /#10 \(fixed by #20\), #11 \(fixed by #21\)/);
    assert.match(md, /40% \(2\/5\)/);
});

test('dependency-bot release notes never count as a follow-up fix', () => {
    const prs = [
        pr(13, owner, { createdAgo: 5 * DAY, mergedAfter: HOUR, body: CLAUDE_FOOTER }),
        pr(14, renovate, { createdAgo: 4 * DAY, mergedAfter: HOUR, body: '- fix(verify): do not panic ([#13](https://example.invalid))' }),
    ];
    assert.equal(findFollowUps(prs.map(normalizePr), { nowMs }).get(13), null);
});

test('saved input drops dependency-bot bodies and reproduces the same metrics', () => {
    const prs = [
        pr(1, renovate, { createdAgo: 3 * DAY, mergedAfter: HOUR, body: 'long release notes', mergedBy: hiveGh }),
        pr(2, hiveGh, { createdAgo: 2 * DAY, mergedAfter: HOUR, title: 'Add X', mergedBy: hiveGh }),
        pr(3, owner, { createdAgo: DAY, mergedAfter: HOUR, title: 'Fix #2' }),
        pr(4, actions, { createdAgo: DAY, body: CLAUDE_FOOTER }),
    ];
    const saved = JSON.parse(JSON.stringify(toSavedInput(prs)));
    assert.equal(saved[0].body, '');
    assert.equal(saved[3].body, CLAUDE_FOOTER);
    assert.deepEqual(computeMetrics(saved, { now: NOW }), computeMetrics(prs, { now: NOW }));
});

test('a fix opened before the PR merged is not a follow-up', () => {
    const prs = [
        pr(30, hiveGh, { createdAgo: 5 * DAY, mergedAfter: 2 * DAY }),
        pr(31, owner, { createdAgo: 4 * DAY, mergedAfter: 2 * DAY, title: 'Fix #30' }),
    ];
    assert.equal(findFollowUps(prs.map(normalizePr), { nowMs }).get(30), null);
});

test('formatting and aligned tables', () => {
    assert.equal(formatDuration(null), 'n/a');
    assert.equal(formatDuration(0.5), '30 min');
    assert.equal(formatDuration(5), '5 h');
    assert.equal(formatDuration(72), '3 d');
    const t = table(['a', 'long header'], [['xxxxx', 1]]);
    assert.equal(new Set(t.map((l) => l.length)).size, 1, 'every row the same width');
    assert.equal(t[1], '| ----- | ----------- |');
});

test('argument parsing rejects bad input', () => {
    assert.equal(parseArgs([]).repo, 'Danathar/appbox');
    assert.equal(parseArgs(['--window-days', '7']).windowDays, 7);
    assert.throws(() => parseArgs(['--window-days', '0']), /positive/);
    assert.throws(() => parseArgs(['--format', 'csv']), /markdown or json/);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
    assert.throws(() => parseArgs(['--now']), /needs a value/);
    assert.throws(() => computeMetrics({}, { now: NOW }), /array/);
    assert.throws(() => computeMetrics([], { now: 'yesterday' }), /--now/);
});

function fakeFetch(pages, calls) {
    return async (url, init) => {
        const { variables } = JSON.parse(init.body);
        calls.push({ url, auth: init.headers.authorization, method: init.method, cursor: variables.cursor });
        const page = pages[calls.length - 1];
        return { ok: true, status: 200, json: async () => page };
    };
}

test('fetchPullRequests pages through GraphQL with the token, read-only', async () => {
    const node = (n) => ({ number: n, title: `t${n}`, body: '', state: 'OPEN', createdAt: NOW, mergedAt: null, closedAt: null, author: hiveGql, mergedBy: null, labels: { nodes: [] } });
    const pages = [
        { data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node(3), node(2)] } } } },
        { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] } } } },
    ];
    const calls = [];
    const prs = await fetchPullRequests('Danathar/appbox', 'tok', { fetchImpl: fakeFetch(pages, calls) });
    assert.deepEqual(prs.map((p) => p.number), [3, 2, 1]);
    assert.deepEqual(calls.map((c) => c.cursor), [null, 'c1']);
    assert.ok(calls.every((c) => c.auth === 'bearer tok' && c.method === 'POST' && c.url.endsWith('/graphql')));
});

test('fetchPullRequests reports errors instead of returning partial data', async () => {
    await assert.rejects(fetchPullRequests('Danathar/appbox', ''), /GITHUB_TOKEN/);
    await assert.rejects(fetchPullRequests('appbox', 'tok'), /owner\/name/);
    const http = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(fetchPullRequests('Danathar/appbox', 'tok', { fetchImpl: http }), /HTTP 401/);
    const gqlErr = async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'bad' }] }) });
    await assert.rejects(fetchPullRequests('Danathar/appbox', 'tok', { fetchImpl: gqlErr }), /bad/);
    const missing = async () => ({ ok: true, status: 200, json: async () => ({ data: { repository: null } }) });
    await assert.rejects(fetchPullRequests('Danathar/nope', 'tok', { fetchImpl: missing }), /not found/);
});

test('CLI with --input is reproducible and writes JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-metrics-'));
    const input = join(dir, 'prs.json');
    const jsonOut = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify([
        pr(1, renovate, { createdAgo: DAY, mergedAfter: HOUR, mergedBy: owner }),
        pr(2, owner, { createdAgo: DAY, body: CLAUDE_FOOTER }),
    ]));
    const args = [SCRIPT, '--input', input, '--now', NOW, '--json-out', jsonOut];
    const env = { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' };
    const first = execFileSync(process.execPath, args, { encoding: 'utf8', env });
    const second = execFileSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(first, second);
    assert.match(first, /from 2 PRs \(1 agent, 0 human, 1 dependency bots, 0 other bots\)/);
    const json = JSON.parse(readFileSync(jsonOut, 'utf8'));
    assert.equal(json.generatedAt, '2026-11-07T12:00:00.000Z');
    assert.equal(json.windows.all.byAuthorClass['dependency-bot'].mergedBy.owner, 1);
    assert.equal(json.windows.all.byAuthorClass.agent.open, 1);
});

test('CLI without input or token fails with a clear message', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /set GITHUB_TOKEN/);
});
