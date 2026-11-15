import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluate,
  renderTable,
  renderCeilingTable,
  loadSummaries,
  pickEntry,
  parseLcov,
  evaluateLcov,
} from '../coverage-gate.mjs';

// The shape kcov writes to coverage/bats/coverage.json: overall numbers at the
// top level, one entry per traced file (percentages as strings) in `files`.
const kcov = (updatePct, installPct = '90.00') => ({
  files: [
    { file: '/w/_temp/appbox-under-test/host/appbox-update', percent_covered: updatePct, covered_lines: '1', total_lines: '1' },
    { file: '/w/_temp/appbox-under-test/host/install', percent_covered: installPct, covered_lines: '1', total_lines: '1' },
  ],
  percent_covered: '70.00',
  covered_lines: 2,
  total_lines: 3,
});

const thresholds = {
  areas: {
    'host/appbox-update': { summary: 'k.json', file: 'host/appbox-update', floor: { lines: 50 } },
  },
};

test('passes at or above the floor, including exactly at the floor', () => {
  assert.deepEqual(evaluate(thresholds, { 'host/appbox-update': kcov('50.00') }).failures, []);
  assert.deepEqual(evaluate(thresholds, { 'host/appbox-update': kcov('100.00') }).failures, []);
});

test('fails below the floor and names the numbers', () => {
  const r = evaluate(thresholds, { 'host/appbox-update': kcov('49.99') });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /host\/appbox-update\.lines: 49\.99% is below the 50% floor/);
});

test('judges the named file, not the overall number', () => {
  // Overall 70% would pass; the named file at 10% must fail.
  const r = evaluate(thresholds, { 'host/appbox-update': kcov('10.00') });
  assert.match(r.failures[0], /10% is below the 50% floor/);
});

test('install is matched by its own suffix, not confused with appbox-update', () => {
  assert.equal(pickEntry(kcov('1', '77.00'), 'host/install').entry.percent_covered, '77.00');
});

test('a suffix only matches at a path boundary', () => {
  const s = { files: [{ file: '/x/myhost/appbox-update', percent_covered: '99' }] };
  assert.match(pickEntry(s, 'host/appbox-update').error, /no entry for host\/appbox-update/);
});

test('a file missing from the summary is a failure', () => {
  const s = kcov('99');
  s.files = s.files.filter((f) => !f.file.endsWith('appbox-update'));
  const r = evaluate(thresholds, { 'host/appbox-update': s });
  assert.match(r.failures[0], /no entry for host\/appbox-update in the summary/);
});

test('two entries for the same file are a failure, not a guess', () => {
  const s = kcov('99');
  s.files.push({ file: '/elsewhere/host/appbox-update', percent_covered: '10' });
  const r = evaluate(thresholds, { 'host/appbox-update': s });
  assert.match(r.failures[0], /2 entries match host\/appbox-update/);
});

test('without `file` the overall percentage is used, number or string', () => {
  const t = { areas: { all: { summary: 'k.json', floor: { lines: 60 } } } };
  assert.deepEqual(evaluate(t, { all: kcov('0') }).failures, []);
  assert.deepEqual(evaluate(t, { all: { percent_covered: 61 } }).failures, []);
  assert.equal(evaluate(t, { all: { percent_covered: 59 } }).failures.length, 1);
});

test('a missing summary file is a failure, not a pass', () => {
  const r = evaluate(thresholds, { 'host/appbox-update': null });
  assert.match(r.failures[0], /no coverage summary at k\.json/);
});

test('a missing or empty percent_covered fails instead of reading as 0 or passing', () => {
  for (const pct of [undefined, null, '']) {
    const t = { areas: { all: { summary: 'k.json', floor: { lines: 0 } } } };
    const r = evaluate(t, { all: { percent_covered: pct } });
    assert.match(r.failures[0], /percent_covered not present/);
  }
});

test('a missing floor fails', () => {
  const t = { areas: { 'host/appbox-update': { summary: 'k.json', file: 'host/appbox-update', floor: {} } } };
  const r = evaluate(t, { 'host/appbox-update': kcov('100') });
  assert.match(r.failures[0], /no floor configured/);
});

test('a config with no areas fails rather than passing vacuously', () => {
  assert.deepEqual(evaluate({ areas: {} }, {}).failures, ['no areas configured']);
  assert.deepEqual(evaluate({}, {}).failures, ['no areas configured']);
});

test('table marks rows below the floor', () => {
  const r = evaluate(thresholds, { 'host/appbox-update': kcov('40') });
  assert.match(renderTable(r.rows), /\| host\/appbox-update \| lines \| 40\.00% \| 50% \| BELOW FLOOR \|/);
});

// Ceilings: the most lines the tests may leave unrun. kcov writes the per-file
// counts as strings.
const withCounts = (covered, total) => ({
  files: [
    {
      file: '/w/_temp/appbox-under-test/host/appbox-update',
      percent_covered: '99.00',
      covered_lines: String(covered),
      total_lines: String(total),
    },
  ],
});
const ceilingThresholds = (max) => ({
  areas: {
    'host/appbox-update': {
      summary: 'k.json',
      file: 'host/appbox-update',
      floor: { lines: 50 },
      ceiling: { missing_lines: max },
    },
  },
});

test('a ceiling passes at or under its count, including exactly at it', () => {
  for (const covered of [159, 161]) {
    const r = evaluate(ceilingThresholds(2), { 'host/appbox-update': withCounts(covered, 161) });
    assert.deepEqual(r.failures, []);
    assert.equal(r.ceilingRows.length, 1);
  }
});

test('one more unrun line than the ceiling fails and names the numbers, though the floor passes', () => {
  // 158 of 161 is 98.1%, far above the 50% floor: only the ceiling catches it.
  const r = evaluate(ceilingThresholds(2), { 'host/appbox-update': withCounts(158, 161) });
  assert.deepEqual(r.failures, ['host/appbox-update: 3 of 161 lines are run by no test, above the ceiling of 2']);
  assert.equal(r.rows[0].ok, true);
});

test('an area without a ceiling is judged on its floor only', () => {
  const r = evaluate(thresholds, { 'host/appbox-update': withCounts(1, 161) });
  assert.deepEqual(r.ceilingRows, []);
});

test('a ceiling that is not a non-negative integer fails instead of being skipped', () => {
  for (const max of [undefined, -1, 1.5, '2', null]) {
    const t = ceilingThresholds(max);
    const r = evaluate(t, { 'host/appbox-update': withCounts(161, 161) });
    assert.deepEqual(r.failures, ['host/appbox-update: ceiling.missing_lines must be a non-negative integer'], String(max));
  }
  const r = evaluate(
    { areas: { u: { summary: 'k.json', floor: { lines: 0 }, ceiling: {} } } },
    { u: { percent_covered: 100, covered_lines: 1, total_lines: 1 } }
  );
  assert.match(r.failures[0], /ceiling\.missing_lines must be/);
});

test('missing or impossible line counts fail the ceiling instead of reading as 0 missing', () => {
  for (const [covered, total] of [[undefined, 161], [161, undefined], ['', ''], [162, 161], [-1, 10], ['x', 10]]) {
    const s = withCounts(0, 0);
    s.files[0].covered_lines = covered;
    s.files[0].total_lines = total;
    const r = evaluate(ceilingThresholds(1000), { 'host/appbox-update': s });
    assert.deepEqual(r.failures, ['host/appbox-update: covered_lines/total_lines not present in summary'], `${covered}/${total}`);
  }
});

test('ceiling table marks rows above the ceiling', () => {
  const r = evaluate(ceilingThresholds(2), { 'host/appbox-update': withCounts(150, 161) });
  assert.match(renderCeilingTable(r.ceilingRows), /\| host\/appbox-update \| 11 \| 161 \| 2 \| ABOVE CEILING \|/);
});

// The lcov report `node --test --test-reporter=lcov` writes, trimmed to the
// records the gate reads.
const lcovText = (lh, lf = 100, sf = '.claude/hooks/guard-bash.mjs') =>
  `TN:\nSF:${sf}\nFN:1,checkGit\nDA:1,1\nLH:${lh}\nLF:${lf}\nend_of_record\n`;
const lcovThresholds = (max) => ({
  areas: thresholds.areas,
  lcov_areas: { guard: { file: '.claude/hooks/guard-bash.mjs', ceiling: { missing_lines: max } } },
});

test('parseLcov reads one entry per SF record with its LF/LH counts', () => {
  const two = lcovText(90) + lcovText(5, 10, 'scripts/x.mjs');
  assert.deepEqual(parseLcov(two).files, [
    { file: '.claude/hooks/guard-bash.mjs', covered_lines: '90', total_lines: '100' },
    { file: 'scripts/x.mjs', covered_lines: '5', total_lines: '10' },
  ]);
  // CRLF line ends and a final record with no end_of_record still parse.
  assert.deepEqual(parseLcov('SF:a.mjs\r\nLF:3\r\nLH:2').files, [{ file: 'a.mjs', covered_lines: '2', total_lines: '3' }]);
});

test('lcov ceiling passes at its count and fails one line above it', () => {
  assert.deepEqual(evaluateLcov(lcovThresholds(10), parseLcov(lcovText(90))).failures, []);
  assert.deepEqual(evaluateLcov(lcovThresholds(10), parseLcov(lcovText(89))).failures, [
    'guard: 11 of 100 lines are run by no test, above the ceiling of 10',
  ]);
});

test('lcov mode matches the file at a path boundary, as the kcov areas do', () => {
  const abs = parseLcov(lcovText(90, 100, '/home/runner/work/appbox/appbox/.claude/hooks/guard-bash.mjs'));
  assert.deepEqual(evaluateLcov(lcovThresholds(10), abs).failures, []);
  const other = parseLcov(lcovText(100, 100, '.claude/hooks/not-guard-bash.mjs'));
  assert.match(evaluateLcov(lcovThresholds(10), other).failures[0], /no entry for \.claude\/hooks\/guard-bash\.mjs/);
});

test('lcov mode fails, not passes, with no lcov_areas, no report, no file or no LF/LH', () => {
  assert.deepEqual(evaluateLcov({ areas: thresholds.areas }, parseLcov(lcovText(1))).failures, ['no lcov_areas configured']);
  assert.deepEqual(evaluateLcov(lcovThresholds(10), null).failures, ['no lcov report']);
  assert.deepEqual(evaluateLcov({ lcov_areas: { g: { ceiling: { missing_lines: 1 } } } }, parseLcov('')).failures, [
    'g: no file configured',
  ]);
  const noCounts = parseLcov('SF:.claude/hooks/guard-bash.mjs\nend_of_record\n');
  assert.match(evaluateLcov(lcovThresholds(10), noCounts).failures[0], /covered_lines\/total_lines not present/);
});

test('the repository thresholds file is valid and covers both host scripts', () => {
  const real = JSON.parse(readFileSync(new URL('../../.coverage-thresholds.json', import.meta.url), 'utf8'));
  assert.equal(real.tool, 'kcov');
  for (const area of ['host/appbox-update', 'host/install']) {
    const cfg = real.areas[area];
    assert.ok(cfg, `${area} is configured`);
    assert.equal(cfg.file, area);
    assert.equal(cfg.summary, 'coverage/bats/coverage.json');
    assert.equal(typeof cfg.floor.lines, 'number');
    assert.ok(cfg.floor.lines > 0 && cfg.floor.lines <= 100);
    assert.ok(Number.isInteger(cfg.ceiling.missing_lines) && cfg.ceiling.missing_lines >= 0);
  }
  const guard = real.lcov_areas['.claude/hooks/guard-bash.mjs'];
  assert.equal(guard.file, '.claude/hooks/guard-bash.mjs');
  assert.ok(Number.isInteger(guard.ceiling.missing_lines) && guard.ceiling.missing_lines >= 0);
});

// The CLI's exit status is what fails the Coverage gate check in CI, so these
// run the script as coverage-gate.yml does, against a throwaway root.
const repo = (summary, config = thresholds) => {
  const root = mkdtempSync(join(tmpdir(), 'appbox-gate-'));
  writeFileSync(join(root, '.coverage-thresholds.json'), JSON.stringify(config));
  if (summary !== undefined) writeFileSync(join(root, 'k.json'), JSON.stringify(summary));
  return root;
};
const gate = (args, cwd) =>
  spawnSync(process.execPath, [new URL('../coverage-gate.mjs', import.meta.url).pathname, ...args], {
    encoding: 'utf8',
    cwd,
  });

test('loadSummaries reads each summary relative to the root, null when absent', () => {
  const config = {
    areas: {
      a: { summary: 'k.json', floor: { lines: 50 } },
      b: { summary: 'missing/coverage.json', floor: { lines: 50 } },
    },
  };
  const root = repo(kcov('97.00'), config);
  assert.deepEqual(loadSummaries(config, root), { a: kcov('97.00'), b: null });
});

test('CLI passes, prints the table and exits 0 at the floor', () => {
  const run = gate(['--root', repo(kcov('50.00'))]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\| host\/appbox-update \| lines \| 50\.00% \| 50% \| ok \|/);
  assert.match(run.stdout, /Coverage gate passed\./);
  assert.equal(run.stderr, '');
});

test('CLI exits 1 and names the failure below the floor', () => {
  const run = gate(['--root', repo(kcov('49.99'))]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /BELOW FLOOR/);
  assert.doesNotMatch(run.stdout, /Coverage gate passed/);
  assert.match(run.stderr, /Coverage gate FAILED:\n {2}- host\/appbox-update\.lines: 49\.99% is below the 50% floor/);
});

test('CLI exits 1 when the kcov summary was never written', () => {
  const run = gate(['--root', repo(undefined)]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /- host\/appbox-update: no coverage summary at k\.json/);
});

test('CLI defaults --root to the working directory', () => {
  const run = gate([], repo(kcov('20')));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /20% is below the 50% floor/);
});

test('CLI --config names the thresholds file under the root', () => {
  const root = repo(kcov('45'));
  mkdirSync(join(root, 'cfg'));
  writeFileSync(
    join(root, 'cfg/t.json'),
    JSON.stringify({ areas: { u: { summary: 'k.json', file: 'host/appbox-update', floor: { lines: 40 } } } })
  );
  const run = gate(['--root', root, '--config', 'cfg/t.json']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\| 45\.00% \| 40% \| ok \|/);
});

test('CLI fails, not passes, on an unreadable thresholds file', () => {
  const root = repo(kcov('100'));
  writeFileSync(join(root, '.coverage-thresholds.json'), '{ not json');
  const run = gate(['--root', root]);
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /Coverage gate passed/);
});

const lcovRepo = (text, config = lcovThresholds(10)) => {
  const root = repo(undefined, config);
  if (text !== undefined) writeFileSync(join(root, 'node.lcov'), text);
  return root;
};

test('CLI --lcov exits 0 and prints the ceiling table at the ceiling', () => {
  const run = gate(['--root', lcovRepo(lcovText(90)), '--lcov', 'node.lcov']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\| guard \| 10 \| 100 \| 10 \| ok \|/);
  assert.match(run.stdout, /Coverage gate passed\./);
});

test('CLI --lcov exits 1 above the ceiling and does not read the kcov areas', () => {
  // No kcov summary exists in this root; lcov mode must not ask for one.
  const run = gate(['--root', lcovRepo(lcovText(80)), '--lcov', 'node.lcov']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /- guard: 20 of 100 lines are run by no test, above the ceiling of 10/);
  assert.doesNotMatch(run.stderr, /no coverage summary/);
});

test('CLI --lcov exits 1 when the report is missing or the flag has no file', () => {
  const missing = gate(['--root', lcovRepo(undefined), '--lcov', 'node.lcov']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /- no lcov report at node\.lcov/);
  // A passing kcov summary sits in the root, so falling back to kcov mode
  // would exit 0: the bare flag must fail on its own.
  const root = lcovRepo(lcovText(100));
  writeFileSync(join(root, 'k.json'), JSON.stringify(kcov('100.00')));
  assert.equal(gate(['--root', root]).status, 0);
  const bare = gate(['--root', root, '--lcov']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /no lcov report at/);
  assert.doesNotMatch(bare.stdout, /Coverage gate passed/);
});

test('CLI kcov mode prints the ceiling table and fails above a ceiling', () => {
  const run = gate(['--root', repo(withCounts(150, 161), ceilingThresholds(2))]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /\| host\/appbox-update \| lines \| 99\.00% \| 50% \| ok \|/);
  assert.match(run.stdout, /\| host\/appbox-update \| 11 \| 161 \| 2 \| ABOVE CEILING \|/);
  assert.match(run.stderr, /11 of 161 lines are run by no test, above the ceiling of 2/);
});
