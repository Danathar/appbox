#!/usr/bin/env node
// PR acceptance metrics for Danathar/appbox.
//
// Lists the repository's pull requests (GitHub GraphQL API, read-only, token
// from GITHUB_TOKEN or GH_TOKEN) or reads a saved list (--input), then reports
// per author class (agent, human, dependency bot, other bot) and per window
// (all time, last N days): PRs opened, merged, closed without merging and
// still open; the acceptance rate; time from opened to merged (median, p90);
// who merged them; and the share of merged PRs that needed a follow-up fix.
//
// Never writes to GitHub. With --input and a fixed --now the output is fully
// reproducible. Definitions: docs/metrics.md. Node built-ins only.
//
// Usage:
//   GITHUB_TOKEN="$(gh auth token)" node scripts/pr-metrics.mjs [--repo Danathar/appbox]
//   node scripts/pr-metrics.mjs --input prs.json [--now 2026-11-07T00:00:00Z]
//   Options: --window-days 30  --follow-up-days 14  --owner Danathar
//            --format markdown|json  --json-out file
//            --save-input file (write the PR list read, for a reproducible snapshot)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'Danathar/appbox';
export const DEFAULT_OWNER = 'Danathar';
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_FOLLOW_UP_DAYS = 14;
export const HIVE_LOGIN = 'danathar-atomic-hive';
export const MAX_PAGES = 20; // 2000 PRs; appbox is far below this

// Accounts whose PRs are written by an AI agent.
export const AGENT_LOGINS = new Set([
    HIVE_LOGIN,
    'claude',
    'copilot-swe-agent',
    'chatgpt-codex-connector',
    'devin-ai-integration',
]);
export const DEPENDENCY_BOT_LOGINS = new Set(['renovate', 'dependabot', 'dependabot-preview']);

// Body text an agent session leaves when it opens a PR under a person's
// account (Claude Code adds the first; the Claude Code GitHub Action, which
// claude.yml and ai-fix.yml run, opens PRs as github-actions with it too).
export const AGENT_BODY_MARKERS = [
    /Generated with \[Claude Code\]/i,
    /^Claude-Session:/im,
    /^Co-Authored-By: Claude\b/im,
];
export const AGENT_LABELS = new Set(['ai-generated', 'agent']);

export const AUTHOR_CLASSES = ['agent', 'human', 'dependency-bot', 'other-bot'];
export const MERGER_CLASSES = ['hive', 'owner', 'other-human', 'bot'];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Login without the `app/` prefix gh adds or the `[bot]` suffix REST adds. */
export function normalizeLogin(login) {
    return String(login ?? '')
        .replace(/^app\//, '')
        .replace(/\[bot\]$/, '');
}

function isBotAccount(account) {
    if (!account) return false;
    const raw = String(account.login ?? '');
    return (
        account.isBot === true ||
        account.is_bot === true ||
        account.__typename === 'Bot' ||
        account.type === 'Bot' ||
        raw.startsWith('app/') ||
        raw.endsWith('[bot]')
    );
}

/**
 * Turn a PR from any of the three shapes this script meets (GraphQL nodes,
 * `gh pr list --json`, REST /pulls) into one flat shape.
 */
export function normalizePr(pr) {
    const author = pr.author ?? pr.user ?? null;
    const mergedBy = pr.mergedBy ?? pr.merged_by ?? null;
    const labelsRaw = pr.labels?.nodes ?? pr.labels ?? [];
    const state = String(pr.state ?? '').toUpperCase();
    const mergedAt = pr.mergedAt ?? pr.merged_at ?? null;
    return {
        number: Number(pr.number),
        title: String(pr.title ?? ''),
        body: String(pr.body ?? ''),
        state: mergedAt ? 'MERGED' : state,
        createdAt: pr.createdAt ?? pr.created_at ?? null,
        mergedAt,
        closedAt: pr.closedAt ?? pr.closed_at ?? null,
        author: author ? { login: normalizeLogin(author.login), isBot: isBotAccount(author) } : null,
        mergedBy: mergedBy ? { login: normalizeLogin(mergedBy.login), isBot: isBotAccount(mergedBy) } : null,
        labels: labelsRaw.map((l) => String(l?.name ?? l)),
    };
}

/** agent | human | dependency-bot | other-bot, for a normalized PR. */
export function classifyPr(pr) {
    const login = pr.author?.login ?? '';
    if (AGENT_LOGINS.has(login)) return 'agent';
    if (DEPENDENCY_BOT_LOGINS.has(login)) return 'dependency-bot';
    const marked =
        AGENT_BODY_MARKERS.some((re) => re.test(pr.body)) ||
        pr.labels.some((l) => AGENT_LABELS.has(l));
    if (marked) return 'agent';
    if (pr.author?.isBot) return 'other-bot';
    return 'human';
}

/** hive | owner | other-human | bot, for whoever pressed merge. */
export function classifyMerger(account, owner = DEFAULT_OWNER) {
    if (!account) return null;
    if (account.login === HIVE_LOGIN) return 'hive';
    if (account.isBot) return 'bot';
    if (account.login.toLowerCase() === owner.toLowerCase()) return 'owner';
    return 'other-human';
}

function toMs(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/** merged | closed | open. */
export function outcomeOf(pr) {
    if (pr.mergedAt) return 'merged';
    if (pr.state === 'CLOSED' || pr.closedAt) return 'closed';
    return 'open';
}

const FIX_WORDS = /\b(fix|fixes|fixed|fixing|follow[- ]?up|revert|reverts|reverted|regression|broke|broken|hotfix)\b/i;

/**
 * True when `later` reads as a fix for `earlier`: it is a GitHub revert of it
 * (`Revert "<title>"`), or one line of its title or body names `#<number>`
 * together with a fix word (fix, follow-up, revert, regression, broke, ...).
 */
export function isFollowUpOf(later, earlier) {
    if (later.number === earlier.number) return false;
    if (later.title === `Revert "${earlier.title}"`) return true;
    const ref = new RegExp(`#${earlier.number}(?![0-9])`);
    const lines = `${later.title}\n${later.body}`.split('\n');
    return lines.some((line) => ref.test(line) && FIX_WORDS.test(line));
}

/**
 * For every merged PR, the number of the first merged PR that fixed it
 * within `followUpDays` of its merge (and at or before `nowMs`), or null.
 * Dependency-bot PRs are never fixes: their bodies quote upstream release
 * notes, whose `fix ... #N` lines name upstream issues, not ours.
 */
export function findFollowUps(prs, { followUpDays = DEFAULT_FOLLOW_UP_DAYS, nowMs }) {
    const limit = followUpDays * DAY_MS;
    const merged = prs.filter((p) => outcomeOf(p) === 'merged' && toMs(p.mergedAt) <= nowMs);
    const result = new Map();
    for (const pr of merged) {
        const mergedMs = toMs(pr.mergedAt);
        const fix = merged
            .filter((other) => classifyPr(other) !== 'dependency-bot')
            .filter((other) => {
                const created = toMs(other.createdAt);
                return created !== null && created >= mergedMs && created - mergedMs <= limit;
            })
            .sort((a, b) => toMs(a.mergedAt) - toMs(b.mergedAt))
            .find((other) => isFollowUpOf(other, pr));
        result.set(pr.number, fix ? fix.number : null);
    }
    return result;
}

/** Median; mean of the two middle values when the count is even. */
export function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100), no interpolation. */
export function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}

const inWindow = (ms, sinceMs, nowMs) => ms !== null && ms <= nowMs && (sinceMs === null || ms >= sinceMs);

/**
 * Summarise a set of normalized PRs for one window. `followUps` comes from
 * findFollowUps over the whole list, so a fix by another class still counts.
 */
export function summarize(prs, { sinceMs = null, nowMs, followUps = new Map(), owner = DEFAULT_OWNER }) {
    const s = {
        opened: 0,
        merged: 0,
        closedUnmerged: 0,
        open: 0,
        acceptanceRate: null,
        timeToMergeHours: { samples: 0, median: null, p90: null },
        mergedBy: Object.fromEntries(MERGER_CLASSES.map((c) => [c, 0])),
        followUp: { needed: 0, share: null, prs: [] },
    };
    const hours = [];
    for (const pr of prs) {
        const created = toMs(pr.createdAt);
        if (inWindow(created, sinceMs, nowMs)) s.opened += 1;
        const outcome = outcomeOf(pr);
        if (outcome === 'open') {
            if (created === null || created <= nowMs) s.open += 1;
            continue;
        }
        const decided = toMs(outcome === 'merged' ? pr.mergedAt : pr.closedAt);
        if (decided !== null && decided > nowMs) {
            // Decided after the report time: it was still open at that time.
            if (created === null || created <= nowMs) s.open += 1;
            continue;
        }
        if (!inWindow(decided, sinceMs, nowMs)) continue;
        if (outcome === 'closed') {
            s.closedUnmerged += 1;
            continue;
        }
        s.merged += 1;
        if (created !== null && decided >= created) hours.push((decided - created) / HOUR_MS);
        const merger = classifyMerger(pr.mergedBy, owner);
        if (merger) s.mergedBy[merger] += 1;
        const fix = followUps.get(pr.number);
        if (fix !== null && fix !== undefined) {
            s.followUp.needed += 1;
            s.followUp.prs.push({ pr: pr.number, fixedBy: fix });
        }
    }
    const decidedCount = s.merged + s.closedUnmerged;
    s.acceptanceRate = decidedCount === 0 ? null : s.merged / decidedCount;
    s.timeToMergeHours = { samples: hours.length, median: median(hours), p90: percentile(hours, 90) };
    s.followUp.share = s.merged === 0 ? null : s.followUp.needed / s.merged;
    return s;
}

/** The whole report: each window, overall and per author class. */
export function computeMetrics(rawPrs, opts = {}) {
    if (!Array.isArray(rawPrs)) throw new TypeError('PR list must be a JSON array');
    const {
        now,
        windowDays = DEFAULT_WINDOW_DAYS,
        followUpDays = DEFAULT_FOLLOW_UP_DAYS,
        owner = DEFAULT_OWNER,
        repo = DEFAULT_REPO,
    } = opts;
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now ?? new Date().toISOString());
    if (Number.isNaN(nowMs)) throw new TypeError('invalid --now timestamp');
    const prs = rawPrs.map(normalizePr);
    const followUps = findFollowUps(prs, { followUpDays, nowMs });
    const byClass = Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, []]));
    for (const pr of prs) byClass[classifyPr(pr)].push(pr);

    const windows = [
        { key: 'all', label: 'all time', sinceMs: null },
        { key: `last${windowDays}d`, label: `last ${windowDays} days`, sinceMs: nowMs - windowDays * DAY_MS },
    ];
    const result = {
        repo,
        generatedAt: new Date(nowMs).toISOString(),
        windowDays,
        followUpDays,
        totalPrs: prs.length,
        prsByClass: Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, byClass[c].map((p) => p.number)])),
        windows: {},
    };
    for (const w of windows) {
        const common = { sinceMs: w.sinceMs, nowMs, followUps, owner };
        result.windows[w.key] = {
            label: w.label,
            since: w.sinceMs === null ? null : new Date(w.sinceMs).toISOString(),
            overall: summarize(prs, common),
            byAuthorClass: Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, summarize(byClass[c], common)])),
        };
    }
    return result;
}

export function formatDuration(hours) {
    if (hours === null || hours === undefined) return 'n/a';
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
    return `${Math.round((hours / 24) * 10) / 10} d`;
}

function pct(numerator, denominator) {
    if (!denominator) return 'n/a';
    return `${Math.round((numerator / denominator) * 1000) / 10}% (${numerator}/${denominator})`;
}

export function formatRate(s) {
    return pct(s.merged, s.merged + s.closedUnmerged);
}

export function formatFollowUp(s) {
    return pct(s.followUp.needed, s.merged);
}

const CLASS_LABELS = {
    agent: 'agent',
    human: 'human',
    'dependency-bot': 'dependency bots',
    'other-bot': 'other bots',
};
const MERGER_LABELS = { hive: 'Hive app', owner: 'owner', 'other-human': 'other humans', bot: 'other bots' };

/** A markdown table with every column padded to the same width. */
export function table(header, rows) {
    const all = [header, ...rows];
    const widths = header.map((_, i) => Math.max(3, ...all.map((r) => String(r[i]).length)));
    const line = (r) => `| ${r.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
    return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)];
}

export function renderMarkdown(m) {
    const counts = AUTHOR_CLASSES.map((c) => `${m.prsByClass[c].length} ${CLASS_LABELS[c]}`).join(', ');
    const lines = [
        '# PR metrics',
        '',
        `${m.repo}, generated ${m.generatedAt} from ${m.totalPrs} PRs (${counts}).`,
        'Definitions: docs/metrics.md.',
        '',
    ];
    for (const w of Object.values(m.windows)) {
        const classes = Object.keys(w.byAuthorClass);
        const statRow = (label, s) => [
            label,
            s.opened,
            s.merged,
            s.closedUnmerged,
            s.open,
            formatRate(s),
            formatDuration(s.timeToMergeHours.median),
            formatDuration(s.timeToMergeHours.p90),
            formatFollowUp(s),
        ];
        lines.push(
            `## ${w.label[0].toUpperCase()}${w.label.slice(1)}`,
            '',
            ...table(
                ['author', 'opened', 'merged', 'closed unmerged', 'open', 'acceptance', 'median to merge', 'p90 to merge', 'needed a follow-up fix'],
                [statRow('all', w.overall), ...classes.map((c) => statRow(CLASS_LABELS[c], w.byAuthorClass[c]))],
            ),
            '',
            'Merged by:',
            '',
            ...table(
                ['author', ...MERGER_CLASSES.map((c) => MERGER_LABELS[c])],
                classes.map((c) => [CLASS_LABELS[c], ...MERGER_CLASSES.map((k) => w.byAuthorClass[c].mergedBy[k])]),
            ),
            '',
        );
        const fixes = w.byAuthorClass.agent.followUp.prs;
        if (fixes.length > 0) {
            lines.push(`Agent PRs that needed a follow-up fix: ${fixes.map((f) => `#${f.pr} (fixed by #${f.fixedBy})`).join(', ')}.`, '');
        }
    }
    return lines.join('\n');
}

const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state createdAt mergedAt closedAt
        author { login __typename }
        mergedBy { login __typename }
        labels(first: 20) { nodes { name } }
      }
    }
  }
}`;

/**
 * Every PR of `repo`, newest first, through the GraphQL API. Read-only.
 * `fetchImpl` is injectable so the tests never touch the network.
 */
export async function fetchPullRequests(repo, token, { fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com/graphql' } = {}) {
    const [owner, name] = String(repo).split('/');
    if (!owner || !name) throw new Error(`--repo must be owner/name, got "${repo}"`);
    if (!token) throw new Error('set GITHUB_TOKEN (or GH_TOKEN), for example GITHUB_TOKEN="$(gh auth token)"');
    const prs = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetchImpl(apiUrl, {
            method: 'POST',
            headers: {
                authorization: `bearer ${token}`,
                'content-type': 'application/json',
                'user-agent': 'appbox-pr-metrics',
            },
            body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor } }),
        });
        if (!res.ok) throw new Error(`GitHub API answered HTTP ${res.status}`);
        const data = await res.json();
        if (data.errors?.length) throw new Error(`GitHub API error: ${data.errors.map((e) => e.message).join('; ')}`);
        const conn = data.data?.repository?.pullRequests;
        if (!conn) throw new Error(`repository ${repo} not found or not readable`);
        prs.push(...conn.nodes);
        if (!conn.pageInfo.hasNextPage) return prs;
        cursor = conn.pageInfo.endCursor;
    }
    throw new Error(`more than ${MAX_PAGES * 100} PRs; raise MAX_PAGES in scripts/pr-metrics.mjs`);
}

/**
 * The PR list as --save-input writes it: normalized, with dependency-bot
 * bodies dropped (long release notes no metric reads). computeMetrics gives
 * the same result for this list as for the original.
 */
export function toSavedInput(prs) {
    return prs.map(normalizePr).map((p) => (classifyPr(p) === 'dependency-bot' ? { ...p, body: '' } : p));
}

export function parseArgs(argv) {
    const opts = {
        repo: DEFAULT_REPO,
        owner: DEFAULT_OWNER,
        format: 'markdown',
        windowDays: DEFAULT_WINDOW_DAYS,
        followUpDays: DEFAULT_FOLLOW_UP_DAYS,
    };
    const value = (flag, i) => {
        if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--input') opts.input = value(a, i++);
        else if (a === '--repo') opts.repo = value(a, i++);
        else if (a === '--now') opts.now = value(a, i++);
        else if (a === '--window-days') opts.windowDays = Number(value(a, i++));
        else if (a === '--follow-up-days') opts.followUpDays = Number(value(a, i++));
        else if (a === '--owner') opts.owner = value(a, i++);
        else if (a === '--format') opts.format = value(a, i++);
        else if (a === '--json-out') opts.jsonOut = value(a, i++);
        else if (a === '--save-input') opts.saveInput = value(a, i++);
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!['markdown', 'json'].includes(opts.format)) throw new Error('--format must be markdown or json');
    for (const k of ['windowDays', 'followUpDays']) {
        if (!Number.isFinite(opts[k]) || opts[k] <= 0) throw new Error(`--${k === 'windowDays' ? 'window-days' : 'follow-up-days'} must be a positive number`);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const prs = opts.input
        ? JSON.parse(readFileSync(opts.input, 'utf8'))
        : await fetchPullRequests(opts.repo, process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    if (opts.saveInput) writeFileSync(opts.saveInput, `${JSON.stringify(toSavedInput(prs), null, 2)}\n`);
    const metrics = computeMetrics(prs, opts);
    if (opts.jsonOut) writeFileSync(opts.jsonOut, `${JSON.stringify(metrics, null, 2)}\n`);
    process.stdout.write(opts.format === 'json' ? `${JSON.stringify(metrics, null, 2)}\n` : `${renderMarkdown(metrics)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        process.stderr.write(`pr-metrics: ${err.message}\n`);
        process.exit(1);
    });
}
