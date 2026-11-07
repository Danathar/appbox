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
// Usage: node scripts/coverage-gate.mjs [--config <file>] [--root <dir>]
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
  const failures = [];
  const areas = thresholds?.areas;
  if (!areas || typeof areas !== 'object' || Object.keys(areas).length === 0) {
    return { rows, failures: ['no areas configured'] };
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
  }
  return { rows, failures };
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
  const { rows, failures } = evaluate(thresholds, loadSummaries(thresholds, root));
  console.log(renderTable(rows));
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
