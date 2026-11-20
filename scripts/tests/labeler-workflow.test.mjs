// .github/workflows/labeler.yml runs on pull_request and holds a
// pull-requests: write token. Its header lists the rules that keep that safe
// and keep it running at all; this file checks them, because each one is a
// one-line edit that leaves every other check green:
//
//   * the trigger stays pull_request. From 2026-12-02 GitHub no longer runs
//     pull_request_target in a public repository without an event policy the
//     hive's App cannot create, so switching back would leave the labeler
//     silently never running;
//   * fork pull requests are skipped by the job's if:, not failed (a fork's
//     pull_request token is read-only);
//   * no step checks out or runs pull request content under the write token;
//   * the action stays pinned to a full commit SHA;
//   * .github/labeler.yml never attaches a label something outside the repo
//     reads as an approval (quality, security, testing, hive/*, agent/*);
//   * every path glob in .github/labeler.yml matches a tracked file, because a
//     rule for a path that was renamed or never existed can never fire and
//     sync-labels hides the gap.
//
// The workflow is read as text with comments stripped (yamlCode, the same
// reader scripts/check-policies.mjs uses), so the repository needs no YAML
// dependency for this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { yamlCode } from '../check-policies.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const code = yamlCode(read('.github/workflows/labeler.yml')).filter((l) => l.trim() !== '');

/** The lines under top-level key `name:`, up to the next top-level key. */
function block(name) {
    const at = code.findIndex((l) => new RegExp(`^${name}\\s*:`).test(l));
    assert.notEqual(at, -1, `labeler.yml has no top-level ${name}:`);
    const out = [];
    for (let j = at + 1; j < code.length && /^\s/.test(code[j]); j++) out.push(code[j]);
    return out;
}

const jobs = block('jobs');
const steps = jobs.filter((l) => /^\s*-\s/.test(l));

test('the scan finds the one job and its step', () => {
    // Guard the guard: the checks below pass on an empty list too.
    const jobNames = jobs.filter((l) => /^ {2}[\w-]+\s*:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
    assert.deepEqual(jobNames, ['label']);
    assert.equal(steps.length, 1);
});

test('it runs on pull_request, not pull_request_target', () => {
    const on = code.find((l) => /^on\s*:/.test(l));
    assert.ok(on, 'labeler.yml has no top-level on:');
    const triggers = block('on').filter((l) => /^ {2}[\w-]+\s*:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
    assert.deepEqual(triggers, ['pull_request']);
    assert.ok(!code.some((l) => /pull_request_target/.test(l)), 'pull_request_target is back in labeler.yml');
    assert.ok(block('on').some((l) => /types:\s*\[opened, synchronize, reopened\]/.test(l)));
});

test('fork pull requests are skipped, not failed', () => {
    const conditions = jobs.filter((l) => /^\s+if\s*:/.test(l)).map((l) => l.replace(/^\s+if\s*:\s*/, '').trim());
    assert.deepEqual(conditions, ['github.event.pull_request.head.repo.full_name == github.repository']);
});

test('no step checks out or runs pull request content under the write token', () => {
    assert.ok(jobs.some((l) => /^\s+pull-requests:\s*write\b/.test(l)), 'the job no longer holds the write token');
    for (const l of jobs) {
        assert.doesNotMatch(l, /^\s*(?:-\s+)?run\s*:/, 'a run: step would execute repository code');
        assert.doesNotMatch(l, /actions\/checkout/, 'checkout under a pull-requests: write token');
        assert.doesNotMatch(l, /^\s+ref\s*:/, 'a ref: input points the action at pull request content');
    }
});

test('every action is pinned to a full commit SHA', () => {
    const uses = jobs.filter((l) => /\buses\s*:/.test(l));
    assert.ok(uses.length > 0);
    for (const l of uses) {
        assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s*$/, `not pinned to a commit: ${l.trim()}`);
    }
});

test('labeler.yml attaches no label read as an approval outside the repository', () => {
    const labels = yamlCode(read('.github/labeler.yml'))
        .map((l) => l.match(/^['"]?([^'"\s:]+)['"]?\s*:/))
        .filter(Boolean)
        .map((m) => m[1]);
    assert.ok(labels.length >= 5, `only found labels ${labels}`);
    for (const label of labels) {
        assert.ok(!['quality', 'security', 'testing'].includes(label), `${label} is an approval label`);
        assert.ok(!/^(?:hive|agent)\//.test(label), `${label} is in an approval namespace`);
    }
});

// The labeler matches with minimatch, dotfiles included: `*` and `?` stop at a
// slash, `**` crosses slashes, and a leading `**/` also matches the root.
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob.startsWith('**/', i)) {
                re += '(?:.*/)?';
                i += 2;
            } else if (glob.startsWith('**', i)) {
                re += '.*';
                i += 1;
            } else {
                re += '[^/]*';
            }
        } else if (ch === '?') {
            re += '[^/]';
        } else {
            re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

/** Every glob listed under any-glob-to-any-file / any-glob-to-all-files. */
function globsOf(configLines) {
    const globs = [];
    for (const l of configLines) {
        const inline = l.match(/^\s+(?:-\s+)?any-glob-to-(?:any|all)-files?\s*:\s+(\S.*)$/);
        const item = l.match(/^\s+-\s+(\S.*)$/);
        const raw = inline ? inline[1] : item && !item[1].trimEnd().endsWith(':') ? item[1] : null;
        if (raw !== null) globs.push(raw.trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
    return globs;
}

const deadGlobs = (configLines, files) =>
    globsOf(configLines).filter((glob) => !files.some((f) => globToRegExp(glob).test(f)));

const tracked = execFileSync('git', ['ls-files'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
})
    .split('\n')
    .filter(Boolean);

test('every path glob in labeler.yml matches a tracked file', () => {
    const config = yamlCode(read('.github/labeler.yml')).filter((l) => l.trim() !== '');
    // Guard the guard: the check below passes on an empty list too.
    assert.ok(tracked.length > 0, 'git ls-files listed nothing');
    assert.ok(globsOf(config).length >= 10, `only found globs ${globsOf(config)}`);
    assert.deepEqual(deadGlobs(config, tracked), []);
});

test('a glob that matches no tracked file is reported', () => {
    const config = [
        "'area/dead':",
        '  - changed-files:',
        "      - any-glob-to-any-file: 'no/such/dir-zz/**'",
        '      - any-glob-to-all-files:',
        "          - 'docs/**'",
        "          - 'no/such/file-zz.txt'",
    ];
    assert.deepEqual(deadGlobs(config, tracked), ['no/such/dir-zz/**', 'no/such/file-zz.txt']);
});

test('glob translation follows minimatch for the constructs labeler.yml uses', () => {
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/README.md'));
    assert.ok(globToRegExp('scripts/*.mjs').test('scripts/check-policies.mjs'));
    assert.ok(!globToRegExp('scripts/*.mjs').test('scripts/tests/a.mjs'));
    assert.ok(globToRegExp('**/*.md').test('README.md'));
    assert.ok(globToRegExp('**/*.md').test('docs/a/b.md'));
    assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/.hidden.yml'));
    assert.ok(!globToRegExp('.github/labeler.yml').test('xgithub/labeler.yml'));
    assert.ok(globToRegExp('a?c').test('abc'));
    assert.ok(!globToRegExp('a?c').test('a/c'));
});
