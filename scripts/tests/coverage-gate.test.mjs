import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate, renderTable, loadSummaries, pickEntry } from '../coverage-gate.mjs';

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
  }
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
