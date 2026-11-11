#!/usr/bin/env node
/**
 * Pull-request-time half of the agent audit trail.
 *
 * scripts/ai-audit-report.mjs reports, once a month and after the merge, a
 * Hive App pull request whose body has no hive signature line; by then the
 * body cannot be fixed. This runs while the pull request is open
 * (.github/workflows/agent-signature.yml) and uses the audit's own
 * findSignature, so the two cannot disagree on what a signature line is.
 *
 * Input: the pull request body in the PR_BODY environment variable (unset
 * reads as empty). Nothing in the body is printed back.
 *
 * Exit codes: 0 the body has a signature line; 1 it does not.
 */

import { fileURLToPath } from 'node:url';

import { SIGNATURE_PREFIX, findSignature } from './ai-audit-report.mjs';

export const MISSING =
    `::error::The pull request body has no hive signature line. Add a line of its own, outside any code block, ` +
    `that starts with '${SIGNATURE_PREFIX}' and names agent=, e.g. '${SIGNATURE_PREFIX} agent=<role> backend=<backend> model=<model>'. ` +
    `The monthly agent audit (agent-audit.yml) reads it.`;

/** Runs the check; returns the exit code. */
export function main(env = process.env, out = process.stdout) {
    if (findSignature(env.PR_BODY) === null) {
        out.write(`${MISSING}\n`);
        return 1;
    }
    out.write('The pull request body has a hive signature line.\n');
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
