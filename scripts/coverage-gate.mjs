#!/usr/bin/env node
// Compares kcov line coverage of the bats unit tests (tests/unit) against the
// floors in .coverage-thresholds.json, and exits 1 when any area is below its
// floor or its numbers cannot be read. Run by .github/workflows/coverage-gate.yml
// after `kcov ... bats tests/unit`.
//
// Each area names a kcov summary (coverage.json) and, optionally, the file in
// it to judge (a path suffix such as "host/appbox-update"). Without `file` the
// summary's overall percentage is used. kcov's bash support measures lines
// only, so lines are the only metric.
//
// An area may also set a ceiling, `"ceiling": { "missing_lines": N }`: the
// most lines the tests may leave unrun. A floor catches tests that stop
// reaching lines; a ceiling catches new lines no test reaches, which a few
// untested lines in a long file never show as a percentage drop.
//
// With `--lcov <file>` the gate instead reads an lcov report (SF/LF/LH
// records, as `node --test --test-reporter=lcov` writes) and checks only the
// ceilings in the `lcov_areas` section, so the kcov job and the Node job each
// check their own numbers.
//
// Usage: node scripts/coverage-gate.mjs [--config <file>] [--root <dir>] [--lcov <file>]
// Node built-ins only.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const METRICS = ['lines'];

/**
 * The numbers to judge for one area: the entry in summary.files whose path
 * ends with `/${file}` (or equals it), or the whole summary when no file is
 * named. Returns { entry } or { error }.
 */
export function pickEntry(summary, file) {
  if (!file) return { entry: summary };
  const files = Array.isArray(summary.files) ? summary.files : [];
  const matches = files.filter(
    (f) => typeof f.file === 'string' && (f.file === file || f.file.endsWith(`/${file}`))
  );
  if (matches.length === 0) return { error: `no entry for ${file} in the summary` };
  if (matches.length > 1) {
    return { error: `${matches.length} entries match ${file}: ${matches.map((m) => m.file).join(', ')}` };
  }
  return { entry: matches[0] };
}

/**
 * @param {object} thresholds parsed .coverage-thresholds.json
 * @param {Record<string, object|null>} summaries area -> parsed kcov coverage.json (null = missing)
 * @returns {{rows: object[], failures: string[]}}
 */
export function evaluate(thresholds, summaries) {
  const rows = [];
  const ceilingRows = [];
  const failures = [];
  const areas = thresholds?.areas;
  if (!areas || typeof areas !== 'object' || Object.keys(areas).length === 0) {
    return { rows, ceilingRows, failures: ['no areas configured'] };
  }
  for (const [area, cfg] of Object.entries(areas)) {
    const summary = summaries[area];
    if (!summary) {
      failures.push(`${area}: no coverage summary at ${cfg.summary}`);
      continue;
    }
    const { entry, error } = pickEntry(summary, cfg.file);
    if (error) {
      failures.push(`${area}: ${error}`);
      continue;
    }
    for (const metric of METRICS) {
      const floor = cfg.floor?.[metric];
      if (typeof floor !== 'number') {
        failures.push(`${area}.${metric}: no floor configured`);
        continue;
      }
      // kcov writes the overall percentage as a number and per-file ones as
      // strings ("87.50"); an absent value must not read as 0 or pass.
      const raw = entry.percent_covered;
      const pct = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(pct)) {
        failures.push(`${area}.${metric}: percent_covered not present in summary`);
        continue;
      }
      const ok = pct >= floor;
      rows.push({ area, metric, pct, floor, ok });
      if (!ok) failures.push(`${area}.${metric}: ${pct}% is below the ${floor}% floor`);
    }
    if (cfg.ceiling !== undefined) checkCeiling(area, cfg.ceiling, entry, ceilingRows, failures);
  }
  return { rows, ceilingRows, failures };
}

/**
 * Checks one area's ceiling: total_lines - covered_lines (kcov writes these as
 * numbers overall and as strings per file) must not exceed
 * ceiling.missing_lines. Appends to ceilingRows and failures.
 */
export function checkCeiling(area, ceiling, entry, ceilingRows, failures) {
  const max = ceiling?.missing_lines;
  if (!Number.isInteger(max) || max < 0) {
    failures.push(`${area}: ceiling.missing_lines must be a non-negative integer`);
    return;
  }
  const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
  const total = num(entry.total_lines);
  const covered = num(entry.covered_lines);
  if (!Number.isInteger(total) || !Number.isInteger(covered) || covered < 0 || covered > total) {
    failures.push(`${area}: covered_lines/total_lines not present in summary`);
    return;
  }
  const missing = total - covered;
  const ok = missing <= max;
  ceilingRows.push({ area, missing, total, max, ok });
  if (!ok) {
    failures.push(
      `${area}: ${missing} of ${total} lines are run by no test, above the ceiling of ${max}`
    );
  }
}

/**
 * Parses an lcov report into [{ file, covered_lines, total_lines }], one per
 * SF record, the shape pickEntry reads. A record missing LF or LH is kept with
 * that count absent, so checkCeiling fails it instead of passing it.
 */
export function parseLcov(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) cur = { file: line.slice(3) };
    else if (cur && line.startsWith('LF:')) cur.total_lines = line.slice(3);
    else if (cur && line.startsWith('LH:')) cur.covered_lines = line.slice(3);
    else if (cur && line === 'end_of_record') {
      files.push(cur);
      cur = null;
    }
  }
  if (cur) files.push(cur);
  return { files };
}

/**
 * Checks the `lcov_areas` ceilings against a parsed lcov report (null when the
 * report is missing).
 * @returns {{ceilingRows: object[], failures: string[]}}
 */
export function evaluateLcov(thresholds, lcov) {
  const ceilingRows = [];
  const failures = [];
  const areas = thresholds?.lcov_areas;
  if (!areas || typeof areas !== 'object' || Object.keys(areas).length === 0) {
    return { ceilingRows, failures: ['no lcov_areas configured'] };
  }
  if (!lcov) return { ceilingRows, failures: ['no lcov report'] };
  for (const [area, cfg] of Object.entries(areas)) {
    if (!cfg?.file) {
      failures.push(`${area}: no file configured`);
      continue;
    }
    const { entry, error } = pickEntry(lcov, cfg.file);
    if (error) {
      failures.push(`${area}: ${error}`);
      continue;
    }
    checkCeiling(area, cfg.ceiling, entry, ceilingRows, failures);
  }
  return { ceilingRows, failures };
}

export function renderTable(rows) {
  const lines = ['| area | metric | measured | floor | status |', '| --- | --- | ---: | ---: | --- |'];
  for (const r of rows) {
    lines.push(
      `| ${r.area} | ${r.metric} | ${r.pct.toFixed(2)}% | ${r.floor}% | ${r.ok ? 'ok' : 'BELOW FLOOR'} |`
    );
  }
  return lines.join('\n');
}

export function renderCeilingTable(ceilingRows) {
  const lines = ['| area | lines no test runs | of | ceiling | status |', '| --- | ---: | ---: | ---: | --- |'];
  for (const r of ceilingRows) {
    lines.push(`| ${r.area} | ${r.missing} | ${r.total} | ${r.max} | ${r.ok ? 'ok' : 'ABOVE CEILING'} |`);
  }
  return lines.join('\n');
}

export function loadSummaries(thresholds, root) {
  const out = {};
  for (const [area, cfg] of Object.entries(thresholds.areas ?? {})) {
    const p = resolve(root, cfg.summary);
    out[area] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  return out;
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const root = resolve(arg('--root', process.cwd()));
  const thresholds = JSON.parse(
    readFileSync(resolve(root, arg('--config', '.coverage-thresholds.json')), 'utf8')
  );
  let failures;
  if (argv.includes('--lcov')) {
    // A bare trailing --lcov must not fall back to the kcov check and pass.
    const lcovFile = arg('--lcov') ?? '';
    const p = resolve(root, lcovFile);
    const lcov = lcovFile && existsSync(p) ? parseLcov(readFileSync(p, 'utf8')) : null;
    const r = evaluateLcov(thresholds, lcov);
    failures = lcov ? r.failures : [`no lcov report at ${lcovFile}`];
    console.log(renderCeilingTable(r.ceilingRows));
  } else {
    const r = evaluate(thresholds, loadSummaries(thresholds, root));
    failures = r.failures;
    console.log(renderTable(r.rows));
    if (r.ceilingRows.length) console.log(`\n${renderCeilingTable(r.ceilingRows)}`);
  }
  if (failures.length) {
    console.error('\nCoverage gate FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nCoverage gate passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
