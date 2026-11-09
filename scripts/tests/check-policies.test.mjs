import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    FLOOR,
    actionInputs,
    checkAll,
    checkRiskTiers,
    checkSecretArgv,
    checkWorkflows,
    classify,
    globToRegExp,
    logicalLines,
    secretArgvFindings,
    walk,
    workflowJobs,
    yamlCode,
} from '../check-policies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const script = path.join(repoRoot, 'scripts', 'check-policies.mjs');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// The real files the policies look at. Fixtures start from these, so a test
// proves the policy against appbox as it is, then changes one thing.
const REAL = [
    'policies/workflow-permissions.json',
    'policies/image-safety.json',
    'policies/repo-target.json',
    'policies/no-secrets.json',
    'policies/secret-argv.json',
    'risk-config.json',
    'docs/risk-tiers.md',
    'scripts/appbox.sh',
    'scripts/claude-desktop-sync',
    'ContainerFiles/appbox',
    'packages/appbox.packages',
    'host/appbox-update',
    'host/install',
    '.github/workflows/build-appbox.yml',
    '.github/workflows/policy-check.yml',
    'cosign.pub',
    'keys/ublue-os-toolboxes.pub',
];

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const GOOD_WF = `name: good
on:
  pull_request:
permissions: {}
jobs:
  one:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
      - run: echo hi
`;

// Built at run time so this file never contains the literal it tests for.
const PRIVATE_HEADER = ['-----BEGIN', 'ENCRYPTED SIGSTORE PRIVATE', 'KEY-----'].join(' ');
const GH_TOKEN = 'ghp' + '_' + 'A'.repeat(36);

/** A temp tree with the real policy inputs, then `files` on top (null deletes). */
function fixture(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-policies-'));
    const all = Object.fromEntries(REAL.map((r) => [r, read(r)]));
    Object.assign(all, files);
    for (const [rel, body] of Object.entries(all)) {
        if (body === null) continue;
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    return dir;
}

const run = (files) => {
    const dir = fixture(files);
    try {
        return checkAll(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};
const has = (vs, re) => vs.some((v) => re.test(v));
const edit = (rel, from, to) => {
    const body = read(rel);
    assert.ok(body.includes(from), `fixture edit: "${from}" not found in ${rel}`);
    return body.replace(from, to);
};
const editJson = (rel, fn) => {
    const obj = JSON.parse(read(rel));
    fn(obj);
    return JSON.stringify(obj, null, 4);
};

// ---------------------------------------------------------------- basics

test('globToRegExp handles **, * and ?', () => {
    assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
    assert.ok(globToRegExp('**/cosign.key').test('cosign.key'));
    assert.ok(globToRegExp('**/cosign.key').test('a/b/cosign.key'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('hosts/x.md'));
    assert.ok(globToRegExp('scripts/?.sh').test('scripts/a.sh'));
    assert.ok(!globToRegExp('scripts/?.sh').test('scripts/ab.sh'));
    assert.ok(!globToRegExp('cosign.pub').test('cosign.pubx'));
});

test('logicalLines joins backslash continuations', () => {
    const lines = logicalLines('a \\\n  b\nc');
    assert.deepEqual(lines, [
        { line: 1, text: 'a  b' },
        { line: 3, text: 'c' },
    ]);
});

test('workflowJobs finds jobs and their own permissions', () => {
    const jobs = workflowJobs(yamlCode(GOOD_WF + '  two:\n    runs-on: x\n    steps: []\n'));
    assert.deepEqual(
        jobs.map((j) => [j.name, j.permissions]),
        [
            ['one', true],
            ['two', false],
        ],
    );
});

test('this repository passes every policy', () => {
    assert.deepEqual(checkAll(repoRoot), []);
});

test('the real inputs in a fixture pass (the fixture is a fair baseline)', () => {
    assert.deepEqual(run(), []);
});

// ------------------------------------------------------------- classify

test('classify takes the highest matching tier and defaults to Tier 1', () => {
    const config = JSON.parse(read('risk-config.json'));
    const tier = (p) => classify(config, p).tier;
    assert.equal(tier('README.md'), 0);
    assert.equal(tier('docs/install.md'), 0);
    assert.equal(tier('docs/reflections/x.md'), 0);
    assert.equal(tier('.claude/memory/x.md'), 0);
    assert.equal(tier('scripts/tests/check-policies.test.mjs'), 0);
    assert.equal(tier('tests/unit/x.bats'), 0);
    assert.equal(tier('scripts/check-policies.mjs'), 1);
    assert.equal(tier('policies/image-safety.json'), 1);
    assert.equal(tier('.github/workflows/ci.yml'), 1);
    assert.equal(tier('.github/labeler.yml'), 1);
    assert.equal(tier('renovate.json'), 1);
    assert.equal(tier('something-new'), 1);
    assert.equal(tier('.github/workflows/build-appbox.yml'), 2);
    assert.equal(tier('host/appbox-update'), 2);
    assert.equal(tier('host/appbox-update.timer'), 2);
    assert.equal(tier('hosts/aurora-think.md'), 2);
    assert.equal(tier('distrobox.ini'), 2);
    assert.equal(tier('scripts/appbox.sh'), 2);
    assert.equal(tier('scripts/claude-desktop-sync'), 2);
    assert.equal(tier('cosign.pub'), 2);
    assert.equal(tier('keys/ublue-os-toolboxes.pub'), 2);
    assert.equal(tier('.claude/settings.json'), 2);
    assert.equal(tier('.claude/hooks/tests/guard.test.mjs'), 2);
    assert.equal(tier('LICENSE'), 2);
});

test('no tier declares a human merge gate', () => {
    const config = JSON.parse(read('risk-config.json'));
    assert.equal(config.merge.human_gate, false);
    for (const t of config.tiers) assert.equal(t.auto_merge, true, `tier ${t.tier}`);
});

// ------------------------------------------------------------ workflows

const wf = (body) => run({ '.github/workflows/t.yml': body });

test('workflows: a compliant workflow passes', () => {
    assert.deepEqual(wf(GOOD_WF), []);
});

test('workflows: permissions read-all and a read-only block pass', () => {
    assert.deepEqual(wf(GOOD_WF.replace('permissions: {}', 'permissions: read-all')), []);
    assert.deepEqual(wf(GOOD_WF.replace('permissions: {}', 'permissions:\n  contents: read\n  issues: read')), []);
});

test('workflows: a missing top-level permissions block fails', () => {
    const vs = wf(GOOD_WF.replace('permissions: {}\n', ''));
    assert.ok(has(vs, /t\.yml: no top-level "permissions:"/), vs.join('\n'));
});

test('workflows: job-level permissions alone do not satisfy a file without the exception', () => {
    const vs = wf(GOOD_WF.replace('permissions: {}\n', ''));
    assert.equal(vs.length, 1);
});

test('workflows: top-level write is rejected in every spelling', () => {
    for (const p of [
        'permissions: write-all',
        'permissions:\n  contents: write',
        'permissions: { contents: write }',
    ]) {
        const vs = wf(GOOD_WF.replace('permissions: {}', p));
        assert.ok(has(vs, /top-level permissions grant write/), `${p}\n${vs.join('\n')}`);
    }
});

test('workflows: job-level write is allowed', () => {
    assert.deepEqual(wf(GOOD_WF.replace('      contents: read', '      contents: read\n      issues: write')), []);
});

test('workflows: the build-appbox exception holds only while every job declares permissions', () => {
    const build = read('.github/workflows/build-appbox.yml');
    assert.ok(!/^permissions\s*:/m.test(build), 'build-appbox.yml gained top-level permissions; drop the exception');
    const extra = build + '\n  extra:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n';
    const vs = run({ '.github/workflows/build-appbox.yml': extra });
    assert.ok(has(vs, /job "extra" has no "permissions:"/), vs.join('\n'));
});

test('workflows: the exception is per file, not a pattern', () => {
    const vs = run({ '.github/workflows/build-other.yml': GOOD_WF.replace('permissions: {}\n', '') });
    assert.ok(has(vs, /build-other\.yml: no top-level/));
});

test('workflows: every action is pinned to a 40-hex SHA, actions/ included', () => {
    for (const ref of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout', 'foo/bar@3d3c42e']) {
        const vs = wf(GOOD_WF.replace(`actions/checkout@${SHA} # v7.0.1`, ref));
        assert.ok(has(vs, /must be pinned to a full commit SHA/), `${ref}\n${vs.join('\n')}`);
    }
});

test('workflows: a pinned action needs a version comment', () => {
    const vs = wf(GOOD_WF.replace(' # v7.0.1', ''));
    assert.ok(has(vs, /needs a trailing "# vX\.Y\.Z" comment/));
});

test('workflows: local and docker:// uses need no pin', () => {
    const body = GOOD_WF.replace(
        '      - run: echo hi',
        '      - uses: ./.github/actions/local\n      - uses: docker://alpine:3',
    );
    assert.deepEqual(wf(body), []);
});

test('workflows: pull_request_target is allowed but may not touch the PR head', () => {
    const prt = GOOD_WF.replace('  pull_request:', '  pull_request_target:');
    assert.deepEqual(wf(prt), []);
    for (const bad of [
        '        with:\n          ref: ${{ github.event.pull_request.head.sha }}',
        '        with:\n          ref: ${{ github.head_ref }}',
        '        with:\n          repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '      - run: git fetch origin refs/pull/1/head',
    ]) {
        const body = prt.replace(`# v7.0.1\n`, `# v7.0.1\n${bad}\n`);
        const vs = wf(body);
        assert.ok(has(vs, /pull_request_target workflow references the PR head/), `${bad}\n${vs.join('\n')}`);
    }
});

test('workflows: bracket access and casing do not hide the PR head (Codex review on #68)', () => {
    const prt = GOOD_WF.replace('  pull_request:', '  pull_request_target:');
    for (const expr of [
        "github['event']['pull_request']['head']['sha']",
        'github["event"]["pull_request"]["head"]["ref"]',
        "github.event['pull_request'].head.sha",
        "github[ 'event' ][ 'pull_request' ][ 'head' ][ 'repo' ][ 'full_name' ]",
        'GitHub.Event.Pull_Request.Head.SHA',
        'GITHUB.HEAD_REF',
        "github['head_ref']",
    ]) {
        const body = prt.replace('# v7.0.1\n', `# v7.0.1\n        with:\n          ref: \${{ ${expr} }}\n`);
        const vs = wf(body);
        assert.ok(has(vs, /pull_request_target workflow references the PR head/), `${expr}\n${vs.join('\n')}`);
    }
});

test('workflows: the PR head is fine in a plain pull_request workflow', () => {
    const body = GOOD_WF.replace('# v7.0.1\n', '# v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n');
    assert.deepEqual(wf(body), []);
});

test('workflows: pull_request_target named only in a comment does not count', () => {
    const body = GOOD_WF.replace('  pull_request:', '  pull_request: # not pull_request_target').replace(
        '# v7.0.1\n',
        '# v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n',
    );
    assert.deepEqual(wf(body), []);
});

test('workflows: inline on: [pull_request_target] is recognised', () => {
    const body = GOOD_WF.replace('on:\n  pull_request:', 'on: [pull_request_target]').replace(
        '      - run: echo hi',
        '      - run: git checkout ${{ github.event.pull_request.head.sha }}',
    );
    assert.ok(has(wf(body), /references the PR head/));
});

test('workflows: attacker-controlled expressions in run: fail, env: use passes', () => {
    for (const e of [
        'github.event.issue.title',
        'github.event.comment.body',
        "github.event['pull_request']['title']",
        'GITHUB.EVENT.ISSUE.BODY',
        'github.head_ref',
        'inputs.text',
    ]) {
        const vs = wf(GOOD_WF.replace('run: echo hi', `run: echo "\${{ ${e} }}"`));
        assert.ok(has(vs, /in a run script; pass it through env:/), `${e}\n${vs.join('\n')}`);
    }
    const viaEnv = GOOD_WF.replace(
        '      - run: echo hi',
        '      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "$TITLE"',
    );
    assert.deepEqual(wf(viaEnv), []);
});

test('workflows: numbers and SHAs from the event are allowed in run:', () => {
    const body = GOOD_WF.replace(
        'run: echo hi',
        'run: |\n          echo ${{ github.event.number }} ${{ github.event.pull_request.head.sha }}',
    );
    assert.deepEqual(wf(body), []);
});

test('workflows: an expression in a multi-line run body is caught', () => {
    const body = GOOD_WF.replace('run: echo hi', 'run: |\n          echo ok\n          echo "${{ github.event.issue.title }}"');
    const vs = wf(body);
    assert.ok(has(vs, /t\.yml:14: /), vs.join('\n'));
});

// ------------------------------------------------ shared regression corpus
//
// policies/check-policies-corpus.json is the one table every copy of this
// checker in the fleet shares (dns-failover, akmods, openaudible-autoupdate,
// tududi, appbox). Each row is a workflow and the run-expression violations
// the checker has to report for it, so a bypass fixed in one copy becomes a
// row, and every copy without the fix fails here (Danathar/akmods#245). The
// canonical copy lives in Danathar/dns-failover, so the file is pinned by hash
// and never edited here.

const CORPUS_FILE = '.github/workflows/check-policies-corpus.yml';
const CORPUS_SHA256 = '7e21db1330eaa6e2ffa0173c7e673cc4f1107fbf2c5a51a254c6f0660506b8df';
const corpusRaw = fs.readFileSync(path.join(repoRoot, 'policies/check-policies-corpus.json'));
const corpus = JSON.parse(corpusRaw.toString('utf8'));
const workflowPolicy = JSON.parse(read('policies/workflow-permissions.json'));

/** The run-expression violations checkWorkflows reports for one corpus workflow. */
function corpusFindings(workflow) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-policies-corpus-'));
    try {
        const file = path.join(dir, CORPUS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${workflow.join('\n')}\n`);
        return checkWorkflows(dir, workflowPolicy, [CORPUS_FILE])
            .map((v) => v.match(/^(.+?):(\d+): \$\{\{\s*(.*?)\s*\}\} in a run script/))
            .filter((m) => m && m[1] === CORPUS_FILE)
            .map((m) => ({ line: Number(m[2]), expression: m[3] }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('corpus: the file is the dns-failover copy', () => {
    assert.equal(
        createHash('sha256').update(corpusRaw).digest('hex'),
        CORPUS_SHA256,
        'policies/check-policies-corpus.json differs from the pinned copy; change it in Danathar/dns-failover and copy it again',
    );
});

test('corpus: every row is well formed and has a unique id', () => {
    assert.equal(corpus.schema, 1);
    assert.ok(corpus.rows.length > 0);
    const ids = new Set();
    for (const row of corpus.rows) {
        assert.match(row.id, /^[a-z0-9-]+$/);
        assert.ok(!ids.has(row.id), `duplicate corpus id ${row.id}`);
        ids.add(row.id);
        assert.equal(typeof row.why, 'string', `${row.id}: why`);
        assert.ok(row.workflow.every((l) => typeof l === 'string'), `${row.id}: workflow`);
        for (const v of row.violations) {
            assert.ok(Number.isInteger(v.line) && v.line >= 1 && v.line <= row.workflow.length, `${row.id}: line`);
            assert.ok(row.workflow[v.line - 1].includes(v.expression), `${row.id}: line ${v.line} names ${v.expression}`);
        }
    }
});

for (const row of corpus.rows) {
    test(`corpus ${row.id}`, () => {
        assert.deepEqual(corpusFindings(row.workflow), row.violations, `${row.id}: ${row.why}`);
    });
}

// ---------------------------------------------------------- secret argv
//
// A program's arguments are readable by every process on the runner
// (/proc/<pid>/cmdline), so a secret must never be one (#84).

const argvPolicy = JSON.parse(read('policies/secret-argv.json'));
const secretFindings = (vs) => vs.filter((v) => /: secret on a command line /.test(v));
const findingLines = (vs) => secretFindings(vs).map((v) => Number(v.match(/^[^:]+:(\d+):/)[1]));

// The "Push To GHCR" step as it was before #84: push-to-registry turned the
// username and password inputs into `podman push --creds=<user>:<token>`.
const OLD_PUSH_WITH = [
    '          registry: ${{ steps.registry_case.outputs.lowercase }}',
    '          username: ${{ env.REGISTRY_USER }}',
    '          password: ${{ env.REGISTRY_PASSWORD }}',
].join('\n');

test('secret-argv: the real workflows pass', () => {
    assert.deepEqual(checkSecretArgv(repoRoot, argvPolicy, walk(repoRoot)), []);
});

test('secret-argv: the old push step with a password input fails (regression for #84)', () => {
    const b = '.github/workflows/build-appbox.yml';
    const body = edit(
        b,
        '        id: push\n        with:\n          image: ${{ steps.build_image.outputs.image }}\n          tags: ${{ steps.build_image.outputs.tags }}\n          registry: ${{ steps.registry_case.outputs.lowercase }}',
        `        id: push\n        env:\n          REGISTRY_USER: \${{ github.actor }}\n          REGISTRY_PASSWORD: \${{ github.token }}\n        with:\n          image: \${{ steps.build_image.outputs.image }}\n          tags: \${{ steps.build_image.outputs.tags }}\n${OLD_PUSH_WITH}`,
    );
    const line = body.split('\n').findIndex((l) => l.includes('password: ${{ env.REGISTRY_PASSWORD }}')) + 1;
    const vs = secretFindings(run({ [b]: body }));
    assert.equal(vs.length, 1, vs.join('\n'));
    assert.match(vs[0], new RegExp(`^\\.github/workflows/build-appbox\\.yml:${line}: secret on a command line \\(password: .* of redhat-actions/push-to-registry`));
});

test('secret-argv: a secret as a credential flag or in a URL is reported', () => {
    for (const line of [
        'podman login --password "$TOKEN" ghcr.io',
        'docker login -u me -p ${{ github.token }} ghcr.io',
        'docker login -u me -p${{ secrets.PAT }} ghcr.io',
        'podman login --password=$REGISTRY_SECRET quay.io',
        'deploy --registry-password "$token" x',
        'skopeo copy --creds "me:$GH_TOKEN" docker://a docker://b',
        'skopeo copy --src-creds=me:${SRC_TOKEN} a b',
        "skopeo copy --dest-creds me:${{ secrets['GHCR_PAT'] }} a b",
        'git push https://x-access-token:$GITHUB_TOKEN@github.com/o/r',
        'git clone "https://oauth2:${{ secrets.GITLAB_TOKEN }}@gitlab.com/o/r"',
        'curl -fsS https://${API_TOKEN}@example.com/x',
    ]) {
        assert.equal(secretArgvFindings(line, argvPolicy).length, 1, line);
    }
});

test('secret-argv: stdin, a file, comments and non-secret values pass', () => {
    for (const line of [
        `printf '%s' "$TOKEN" | podman login ghcr.io -u me --password-stdin`,
        `printf '%s' "\${{ secrets.PAT }}" | podman login ghcr.io -u me --password-stdin`,
        `printf '%s' "$GH_TOKEN" > "$RUNNER_TEMP/token"`,
        'podman login -u "$REGISTRY_ACTOR" --password-stdin ghcr.io',
        'mkdir -p "$RUNNER_TEMP/bin"',
        'psql -p "$PGPORT" -U "$PGUSER"',
        'skopeo inspect --retry-times 0 "docker://$IMAGE:latest"',
        '# never: podman login -p "$REGISTRY_TOKEN"',
    ]) {
        assert.deepEqual(secretArgvFindings(line, argvPolicy), [], line);
    }
});

test('secret-argv: run scripts and push-to-registry inputs are checked, login-action is not', () => {
    const body = GOOD_WF.replace('      - run: echo hi', [
        '      - run: docker login ghcr.io -u me -p "${{ secrets.REGISTRY_PASSWORD }}"',
        '      - name: multi',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '        run: |',
        '          skopeo copy \\',
        '            --creds "me:$GH_TOKEN" docker://a docker://b',
        '          git clone "https://x-access-token:${GH_TOKEN}@github.com/o/r"',
        '          podman login --password "$TOKEN" quay.io',
        '          deploy --registry-password "$TOKEN" x',
        `          printf '%s' "$GH_TOKEN" | podman login ghcr.io -u me --password-stdin`,
        `          printf '%s' "$GH_TOKEN" > "$RUNNER_TEMP/token"`,
        '          mkdir -p certs',
        '          # never: podman login -p "$GH_TOKEN"',
        '      - name: Push',
        `        uses: redhat-actions/push-to-registry@${SHA} # v3.0.0`,
        '        with:',
        '          registry: ghcr.io/o',
        '          username: ${{ github.actor }}',
        '          password: ${{ github.token }}',
        `      - uses: docker/login-action@${SHA} # v4.8.0`,
        '        with:',
        '          username: ${{ github.actor }}',
        '          password: ${{ secrets.GITHUB_TOKEN }}',
    ].join('\n'));
    assert.deepEqual(findingLines(wf(body)), [12, 17, 19, 20, 21, 31]);
});

test('secret-argv: push-to-registry without a password input passes', () => {
    const body = GOOD_WF.replace('      - run: echo hi', [
        `      - uses: redhat-actions/push-to-registry@${SHA} # v3.0.0`,
        '        env:',
        '          password: ${{ github.token }}',
        '        with:',
        '          image: appbox',
        '          registry: ghcr.io/o',
    ].join('\n'));
    assert.deepEqual(wf(body), []);
    const inputs = actionInputs(yamlCode(body), 'redhat-actions/push-to-registry');
    assert.deepEqual(inputs.map((x) => x.name), ['image', 'registry']);
});

// --------------------------------------------------------- image safety

test('image: claude-desktop in the package list fails, a comment does not', () => {
    const pk = 'packages/appbox.packages';
    assert.ok(has(run({ [pk]: read(pk) + 'claude-desktop\n' }), /appbox\.packages:\d+: claude-desktop is proprietary/));
    assert.deepEqual(run({ [pk]: read(pk) + '# not claude-desktop, it is proprietary\n' }), []);
    assert.deepEqual(run({ [pk]: read(pk) + 'claude-desktop-helper-free\n' }), []);
});

test('image: installing claude-desktop in the build script fails', () => {
    const sh = 'scripts/appbox.sh';
    for (const line of [
        'apt-get install -y signal-desktop claude-desktop',
        'apt-get -y install claude-desktop=1.2.3',
        'apt install claude-desktop',
        'dpkg -i /tmp/claude-desktop_1.2.3_amd64.deb',
        'apt-get install -y \\\n    claude-desktop',
        'true && apt-get install -y claude-desktop:amd64',
    ]) {
        const vs = run({ [sh]: edit(sh, 'apt-get clean', `${line}\napt-get clean`) });
        assert.ok(has(vs, /installs claude-desktop, which is proprietary/), `${line}\n${vs.join('\n')}`);
    }
});

test('image: a quoted package name is still an install (Codex review on #68)', () => {
    const cf = 'ContainerFiles/appbox';
    const sh = 'scripts/appbox.sh';
    assert.ok(has(run({ [cf]: read(cf) + 'RUN apt-get install -y "claude-desktop"\n' }), /ContainerFiles\/appbox:\d+: installs claude-desktop/));
    for (const line of [
        "apt-get install -y 'claude-desktop'",
        'apt-get install -y "claude-desktop=1.2.3"',
        'apt-get install -y signal-desktop "claude-desktop"',
        'dpkg -i "/tmp/claude-desktop_1.2.3_amd64.deb"',
        'echo "starting; really" && apt-get install -y "claude-desktop"',
    ]) {
        const vs = run({ [sh]: edit(sh, 'apt-get clean', `${line}\napt-get clean`) });
        assert.ok(has(vs, /installs claude-desktop, which is proprietary/), `${line}\n${vs.join('\n')}`);
    }
});

test('image: quoted text in a log message after an install is not a package', () => {
    const sh = 'scripts/appbox.sh';
    for (const line of [
        'apt-get install -y foo || echo "claude-desktop is installed at box start"',
        'echo "apt-get install -y claude-desktop; happens at box start"',
        "echo 'apt-get install claude-desktop | later'",
    ]) {
        assert.deepEqual(run({ [sh]: edit(sh, '\napt-get update\n', `\n${line}\napt-get update\n`) }), [], line);
    }
});

test('image: a simulated install, a log line and the init hook name are not installs', () => {
    const sh = 'scripts/appbox.sh';
    for (const line of [
        'apt-get --simulate install claude-desktop > /dev/null',
        'echo "apt-get install claude-desktop happens at box start"',
        'install -D -m 0755 claude-desktop-sync /usr/libexec/appbox/claude-desktop-sync',
        '# apt-get install -y claude-desktop',
    ]) {
        assert.deepEqual(run({ [sh]: edit(sh, '\napt-get update\n', `\n${line}\napt-get update\n`) }), [], line);
    }
});

test('image: the Containerfile is checked too', () => {
    const cf = 'ContainerFiles/appbox';
    const vs = run({ [cf]: read(cf) + 'RUN apt-get update && apt-get install -y claude-desktop\n' });
    assert.ok(has(vs, /ContainerFiles\/appbox:\d+: installs claude-desktop/));
});

test('image: removing the not-installed guard, or installing after it, fails', () => {
    const sh = 'scripts/appbox.sh';
    const guard = read(sh).match(/if dpkg-query[^\n]*claude-desktop[^\n]*\n[^\n]*\n[^\n]*\n\s*fi\n/);
    assert.ok(guard, 'guard block not found in scripts/appbox.sh');
    assert.ok(has(run({ [sh]: read(sh).replace(guard[0], '') }), /"image-no-proprietary": the check that fails the build/));
    const late = edit(sh, 'apt-get clean', 'apt-get install -y something-else\napt-get clean');
    assert.ok(has(run({ [sh]: late }), /"image-no-proprietary".*(missing|out of order)/));
});

test('image: options that disable verification fail, in code but not in comments', () => {
    const cases = [
        ['scripts/appbox.sh', 'echo "deb [trusted=yes] http://x stable main" > /etc/apt/sources.list.d/x.list'],
        ['scripts/appbox.sh', 'apt-get install -y --allow-unauthenticated foo'],
        ['scripts/appbox.sh', 'curl -fsSLk -o /tmp/k https://x'],
        ['scripts/appbox.sh', 'curl --insecure -o /tmp/k https://x'],
        ['host/appbox-update', 'cosign verify --insecure-ignore-tlog --key k img'],
        ['host/appbox-update', 'podman pull --tls-verify=false img'],
    ];
    for (const [rel, line] of cases) {
        const body = read(rel) + `\n${line}\n`;
        assert.ok(has(run({ [rel]: body }), /forbidden option/), `${rel}: ${line}`);
        assert.deepEqual(run({ [rel]: read(rel) + `\n# ${line}\n` }), [], `comment: ${line}`);
    }
});

test('image: the build must verify the base, build, push, sign and verify, in that order', () => {
    const b = '.github/workflows/build-appbox.yml';
    const noSign = read(b).replace(/cosign sign /, 'echo skip ');
    assert.ok(has(run({ [b]: noSign }), /"build-signing": signing the pushed digest is missing/));
    const noBase = read(b).replace('cosign verify --key keys/ublue-os-toolboxes.pub', 'echo');
    assert.ok(has(run({ [b]: noBase }), /"build-signing": the check of ublue's signature on the base image is missing/));
    const noVerify = read(b).replace('cosign verify --key cosign.pub', 'echo');
    assert.ok(has(run({ [b]: noVerify }), /verifying the new signature.*missing/));
    // Base check moved after the build step.
    const lines = read(b).split('\n');
    const i = lines.findIndex((l) => l.includes('cosign verify --key keys/ublue-os-toolboxes.pub'));
    const moved = [...lines];
    const [baseLine] = moved.splice(i, 1);
    const j = moved.findIndex((l) => l.includes('cosign sign'));
    moved.splice(j, 0, baseLine);
    assert.ok(has(run({ [b]: moved.join('\n') }), /"build-signing".*out of order/));
});

test('image: a commented-out signing step does not count', () => {
    const b = '.github/workflows/build-appbox.yml';
    const body = read(b).replace(/(\s+)cosign sign /, '$1# cosign sign ');
    assert.ok(has(run({ [b]: body }), /signing the pushed digest is missing/));
});

test('host: the updater must pull, verify, re-check, pin and recreate in order', () => {
    const h = 'host/appbox-update';
    assert.ok(has(run({ [h]: edit(h, '"${cosign}" verify --key', 'true') }), /"host-rebuild": cosign verification/));
    assert.ok(has(run({ [h]: edit(h, 's|^pull=.*|pull=false|', 's|^pull=.*|pull=true|') }), /no second pull/));
    const noRecheck = read(h).replace(/    if running="\$\(app_running_in_box\)"; then\n        echo "Skipping rebuild: \$\{running\} started/, '    if false; then\n        echo "x');
    assert.notEqual(noRecheck, read(h), 'fixture edit did not apply');
    // The next app_running_in_box is the in-place one, after the recreate, so
    // the sequence breaks at the step after it.
    assert.ok(has(run({ [h]: noRecheck }), /"host-rebuild": .*out of order/));
});

test('host: in-place upgrades must check that the app is closed first', () => {
    const h = 'host/appbox-update';
    const body = edit(h, 'if running="$(app_running_in_box "${pkg}")"; then', 'if false; then');
    assert.ok(has(run({ [h]: body }), /"host-upgrade": the per-app is-it-open check is missing/));
});

test('init hook: never upgrade, always end with exit 0, no errexit', () => {
    const k = 'scripts/claude-desktop-sync';
    assert.ok(has(run({ [k]: edit(k, '\nexit 0', '\napt-get install -y --only-upgrade claude-desktop\nexit 0') }), /must never upgrade/));
    assert.ok(has(run({ [k]: edit(k, '\nexit 0', '\napt-get -y upgrade\nexit 0') }), /must never upgrade/));
    assert.deepEqual(run({ [k]: edit(k, '\nexit 0', '\necho "upgrades come from the host timer"\nexit 0') }), []);
    assert.ok(has(run({ [k]: edit(k, '\nexit 0', '\nexit 1') }), /last command must be "exit 0"/));
    assert.ok(has(run({ [k]: edit(k, '\nexit 0', '\nexit 0\ntrue') }), /last command must be "exit 0"/));
    assert.ok(has(run({ [k]: edit(k, '#!/bin/sh\n', '#!/bin/sh\nset -eu\n') }), /would let one failed command abort/));
});

test('trust chain: public keys must exist and be public keys', () => {
    assert.ok(has(run({ 'cosign.pub': null }), /cosign\.pub: missing/));
    assert.ok(has(run({ 'keys/ublue-os-toolboxes.pub': 'nope\n' }), /does not look like a public key/));
});

// ---------------------------------------------------------- repo target

test('repo-target: governance docs need -R Danathar/appbox on gh writes', () => {
    const f = 'docs/ai-ops-runbook.md';
    assert.ok(has(run({ [f]: 'gh pr create --base main\n' }), /without -R Danathar\/appbox/));
    assert.ok(has(run({ [f]: 'gh workflow run build-appbox\n' }), /without -R/));
    assert.ok(has(run({ [f]: 'gh secret set SIGNING_SECRET < cosign.key\n' }), /without -R/));
    assert.deepEqual(run({ [f]: 'gh pr create -R Danathar/appbox --base main\n' }), []);
    assert.deepEqual(run({ [f]: 'gh pr create --repo=Danathar/appbox\n' }), []);
    assert.deepEqual(run({ [f]: 'gh pr create \\\n  -R Danathar/appbox\n' }), []);
    assert.deepEqual(run({ [f]: 'gh pr list\ngh run view 1 --log-failed\n' }), []);
});

test('repo-target: a lookalike repository is not this one', () => {
    const f = 'docs/multi-agent.md';
    const vs = run({ [f]: 'gh pr create -R Danathar/appbox-old\n' });
    assert.ok(has(vs, /names another repository/));
});

test('repo-target: other docs may omit -R but may never name another repository', () => {
    assert.deepEqual(run({ 'README.md': 'gh workflow run build-appbox\n' }), []);
    for (const line of [
        'gh issue create -R ublue-os/toolboxes --title x',
        'gh pr comment 3 --repo "someone/else" --body x',
        'GH_REPO=someone/else gh issue list',
        'gh repo set-default someone/else',
    ]) {
        assert.ok(has(run({ 'CONTRIBUTING.md': `${line}\n` }), /names another repository/), line);
    }
    assert.deepEqual(run({ 'CONTRIBUTING.md': 'gh pr view 1 -R ublue-os/toolboxes\n' }), []);
});

test('repo-target: workflows may not point GH_REPO at another repository', () => {
    const body = GOOD_WF.replace('      - run: echo hi', '      - env:\n          GH_REPO: someone/else\n        run: gh issue list');
    assert.ok(has(wf(body), /names another repository/));
    const ok = GOOD_WF.replace('      - run: echo hi', '      - env:\n          GH_REPO: ${{ github.repository }}\n        run: gh issue create --title x --body y');
    assert.deepEqual(wf(ok), []);
});

// ------------------------------------------------------------ no secrets

test('no-secrets: secret-looking files fail', () => {
    for (const f of ['cosign.key', 'keys/cosign.key', '.env', 'hosts/.env.local', 'id_ed25519', 'x/server.key']) {
        assert.ok(has(run({ [f]: 'x\n' }), new RegExp(`${f.replace(/\./g, '\\.')}: secret-looking file`)), f);
    }
    assert.deepEqual(run({ 'hosts/example.env': 'APPBOX_MAX_AGE_DAYS=7\n' }), []);
});

test('no-secrets: private key or token content fails, and the message carries only the path', () => {
    const vs = run({ 'docs/notes.md': `${PRIVATE_HEADER}\nsecretbody\n` });
    assert.ok(has(vs, /docs\/notes\.md: contains private key material/));
    assert.ok(!vs.join('\n').includes('secretbody'));
    assert.ok(has(run({ 'x.txt': `token=${GH_TOKEN}\n` }), /x\.txt: contains/));
});

test('no-secrets: a public key is fine', () => {
    assert.deepEqual(run({ 'keys/extra.pub': read('cosign.pub') }), []);
});

// ----------------------------------------------------------- risk tiers

const TABLE = `
| Tier | Name | Covers | Required commands | Scrutiny |
| ---- | ---- | ------ | ----------------- | -------- |
| 0 | docs | \`docs/**\` | none | \`standard\` |
| 2 | live | \`host/**\`, \`cosign.pub\` | \`shellcheck host/appbox-update\` | \`highest\` |
`;
const CONFIG = () => ({
    default_tier: 0,
    tiers: [
        { tier: 0, name: 'docs', paths: ['docs/**'], required_commands: [], scrutiny: 'standard' },
        { tier: 2, name: 'live', paths: ['host/**', 'cosign.pub'], required_commands: ['shellcheck host/appbox-update'], scrutiny: 'highest' },
    ],
});

test('risk tiers: matching table and JSON pass', () => {
    assert.deepEqual(checkRiskTiers(CONFIG(), TABLE), []);
});

test('risk tiers: path, command, name and scrutiny drift are reported', () => {
    const c = CONFIG();
    c.tiers[1].paths.push('keys/**');
    c.tiers[1].required_commands = [];
    c.tiers[0].name = 'documentation';
    c.tiers[1].scrutiny = 'standard';
    const vs = checkRiskTiers(c, TABLE.replace('`docs/**`', '`docs/**`, `*.md`'));
    assert.ok(has(vs, /"keys\/\*\*" is in risk-config\.json but not in the table/));
    assert.ok(has(vs, /"\*\.md" is in the table but not in risk-config\.json/));
    assert.ok(has(vs, /required commands: "shellcheck host\/appbox-update" is in the table/));
    assert.ok(has(vs, /tier 0 is named "docs", risk-config\.json says "documentation"/));
    assert.ok(has(vs, /tier 2 scrutiny is "highest", risk-config\.json says "standard"/));
});

test('risk tiers: missing and extra tiers, bad default, duplicates, malformed rows', () => {
    const c = CONFIG();
    c.tiers.push({ tier: 1, name: 'tooling', paths: [], required_commands: [], scrutiny: 'elevated' });
    c.default_tier = 9;
    let vs = checkRiskTiers(c, TABLE + '| 3 | extra | `x` | none | `standard` |\n| 4 | short | x |\n');
    assert.ok(has(vs, /tier 1 \(tooling\) is in risk-config\.json but not in the table/));
    assert.ok(has(vs, /tier 3 is in the table but not in risk-config\.json/));
    assert.ok(has(vs, /default_tier 9 is not a defined tier/));
    assert.ok(has(vs, /malformed tier row/));
    const d = CONFIG();
    d.tiers.push({ ...d.tiers[0] });
    vs = checkRiskTiers(d, TABLE);
    assert.ok(has(vs, /duplicate tier numbers/));
    assert.deepEqual(checkRiskTiers({ tiers: [] }, TABLE), ['risk-config.json: "tiers" must be a non-empty array']);
});

test('risk tiers: the real doc and config agree', () => {
    assert.deepEqual(checkRiskTiers(JSON.parse(read('risk-config.json')), read('docs/risk-tiers.md')), []);
});

// ---------------------------------------------------------------- floor

test('floor: dropping claude-desktop from the proprietary list fails', () => {
    const p = 'policies/image-safety.json';
    const vs = run({ [p]: editJson(p, (o) => (o.proprietaryPackages = [])) });
    assert.ok(has(vs, /proprietaryPackages must include "claude-desktop"/));
});

test('floor: dropping a required sequence, init hook or public key fails', () => {
    const p = 'policies/image-safety.json';
    for (const [fn, re] of [
        [(o) => (o.requiredSequences = o.requiredSequences.filter((s) => s.name !== 'build-signing')), /requiredSequences must include "build-signing"/],
        [(o) => (o.initHooks = []), /initHooks must include "scripts\/claude-desktop-sync"/],
        [(o) => (o.publicKeys = []), /publicKeys must include "cosign\.pub"/],
        [(o) => (o.imageBuildFiles = ['scripts/appbox.sh']), /imageBuildFiles must include "ContainerFiles\/appbox"/],
    ]) {
        assert.ok(has(run({ [p]: editJson(p, fn) }), re), re.source);
    }
});

test('floor: loosening the workflow policy fails', () => {
    const p = 'policies/workflow-permissions.json';
    for (const [fn, re] of [
        [(o) => (o.requireTopLevelPermissions = false), /requireTopLevelPermissions must stay true/],
        [(o) => (o.trustedActionOwners = ['actions']), /trustedActionOwners must stay empty/],
        [(o) => (o.pinPattern = '.*'), /pinPattern must stay/],
        [(o) => delete o.forbiddenRunExpressions, /forbiddenRunExpressions must stay set/],
        [(o) => o.jobPermissionsSuffice.push({ file: '.github/workflows/ci.yml', reason: 'x' }), /may only list build-appbox\.yml/],
    ]) {
        assert.ok(has(run({ [p]: editJson(p, fn) }), re), re.source);
    }
});

test('floor: moving a Tier 2 path out of the top tier fails even when doc and JSON agree', () => {
    const cfg = editJson('risk-config.json', (o) => {
        const t2 = o.tiers.find((t) => t.tier === 2);
        t2.paths = t2.paths.filter((x) => x !== 'host/**');
    });
    const doc = read('docs/risk-tiers.md').replace('`host/**`, ', '');
    const vs = run({ 'risk-config.json': cfg, 'docs/risk-tiers.md': doc });
    assert.deepEqual(vs, ['risk-config.json: "host/**" must stay in the highest tier (policy floor (scripts/check-policies.mjs FLOOR))']);
});

test('floor: lists every Tier 2 path named in the brief', () => {
    for (const p of ['host/**', 'cosign.pub', '.github/workflows/build-appbox.yml', '.claude/hooks/**']) {
        assert.ok(FLOOR.tier2Paths.includes(p), p);
    }
});

// ------------------------------------------------------- missing inputs

test('missing policy files and the tier doc are violations, not skipped checks', () => {
    const vs = run({
        'policies/image-safety.json': null,
        'policies/no-secrets.json': null,
        'policies/secret-argv.json': null,
        'docs/risk-tiers.md': null,
    });
    assert.ok(has(vs, /^policies\/image-safety\.json: missing$/));
    assert.ok(has(vs, /^policies\/no-secrets\.json: missing$/));
    assert.ok(has(vs, /^policies\/secret-argv\.json: missing$/));
    assert.ok(has(vs, /^docs\/risk-tiers\.md: missing$/));
});

test('a missing guarded file is a violation, not a pass', () => {
    for (const f of ['scripts/appbox.sh', 'host/appbox-update', 'scripts/claude-desktop-sync', 'packages/appbox.packages']) {
        assert.ok(has(run({ [f]: null }), new RegExp(`${f.replace(/\./g, '\\.')}: missing`)), f);
    }
});

test('invalid JSON is reported and the other policies still run', () => {
    const vs = run({ 'policies/repo-target.json': '{', 'packages/appbox.packages': 'claude-desktop\n' });
    assert.ok(has(vs, /repo-target\.json: invalid JSON/));
    assert.ok(has(vs, /claude-desktop is proprietary/));
});

test('.git and node_modules are never walked', () => {
    assert.deepEqual(run({ '.git/cosign.key': 'x', 'node_modules/a/.env': 'x' }), []);
});

// ------------------------------------------------------------------ cli

test('cli: exits 0 when clean, 1 with violations, and --classify prints tiers', () => {
    const clean = fixture();
    const dirty = fixture({ 'packages/appbox.packages': 'claude-desktop\n' });
    try {
        let r = spawnSync(process.execPath, [script, '--root', clean], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /all policies satisfied/);
        r = spawnSync(process.execPath, [script, '--root', dirty], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /1 violation\(s\)/);
        r = spawnSync(process.execPath, [script, '--root', clean, '--classify', 'host/appbox-update', './docs/x.md'], { encoding: 'utf8' });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /host\/appbox-update: tier 2 \(live\), scrutiny: highest/);
        assert.match(r.stdout, /\.\/docs\/x\.md: tier 0 \(docs\), scrutiny: standard/);
    } finally {
        fs.rmSync(clean, { recursive: true, force: true });
        fs.rmSync(dirty, { recursive: true, force: true });
    }
});
