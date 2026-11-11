// scripts/pr-signature-check.mjs and .github/workflows/agent-signature.yml:
// the open pull request check for the hive signature line the monthly audit
// requires. The check must use the audit's own findSignature, take the body
// only from PR_BODY, and run only on agent pull requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { MISSING, main } from '../pr-signature-check.mjs';
import { SIGNATURE_PREFIX, findSignature } from '../ai-audit-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SCRIPT = join(repoRoot, 'scripts', 'pr-signature-check.mjs');
const WORKFLOW = readFileSync(join(repoRoot, '.github', 'workflows', 'agent-signature.yml'), 'utf8');
const SIG = `${SIGNATURE_PREFIX} agent=scanner backend=claude model=claude-opus-5-5`;

function run(env) {
    let written = '';
    const code = main(env, { write: (s) => { written += s; } });
    return { code, written };
}

const PASSING = [
    `**Summary:** a change.\n\nRefs #1\n\n${SIG}\n`,
    `Summary\r\n\r\n${SIG}\r\n`,
    `  ${SIG}  `,
    `${SIGNATURE_PREFIX} agent=docs-writer`,
];

const FAILING = [
    undefined,
    '',
    'Summary\n\nFiled by quality agent\n',
    `${SIGNATURE_PREFIX}\n`,
    `${SIGNATURE_PREFIX} backend=claude model=x\n`,
    `Quoted: ${SIG}\n`,
    `Example:\n\`\`\`\n${SIG}\n\`\`\`\n`,
    '- hive: agent=scanner backend=claude model=x\n',
];

test('a body the audit accepts passes, with no error line', () => {
    for (const body of PASSING) {
        assert.notEqual(findSignature(body), null, JSON.stringify(body));
        const { code, written } = run({ PR_BODY: body });
        assert.equal(code, 0, JSON.stringify(body));
        assert.doesNotMatch(written, /::error::/);
    }
});

test('a body the audit rejects fails with one error line', () => {
    for (const body of FAILING) {
        assert.equal(findSignature(body), null, JSON.stringify(body));
        const { code, written } = run(body === undefined ? {} : { PR_BODY: body });
        assert.equal(code, 1, JSON.stringify(body));
        assert.equal(written, `${MISSING}\n`);
    }
});

test('the body is never printed back', () => {
    const { written } = run({ PR_BODY: `::warning::injected\n${SIG}` });
    assert.doesNotMatch(written, /injected/);
});

test('run as a command, it exits with the check result and reads PR_BODY', () => {
    const env = { PATH: process.env.PATH };
    const ok = spawnSync(process.execPath, [SCRIPT], { env: { ...env, PR_BODY: SIG }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const missing = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stdout, /^::error::/);
});

test('the workflow runs the script on pull_request, only for agent pull requests', () => {
    assert.match(WORKFLOW, /^on:\n {2}pull_request:\n {4}types: \[opened, edited, reopened, synchronize\]\n/m);
    const code = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /pull_request_target/);
    assert.match(code, /^permissions: \{\}\n/m);
    assert.match(code, /^ {4}permissions:\n {6}contents: read\n {4}steps:\n/m);
    assert.match(code, /^ {2}signature:\n {4}if: >-\n/m);
    assert.match(code, /github\.event\.pull_request\.user\.login == 'danathar-atomic-hive\[bot\]'/);
    assert.match(code, /startsWith\(github\.event\.pull_request\.head\.ref, 'ai-fix\/'\)/);
    assert.match(code, / {10}PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}\n {8}run: node scripts\/pr-signature-check\.mjs\n/);
});
