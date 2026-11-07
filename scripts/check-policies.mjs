#!/usr/bin/env node
/**
 * Policy-as-code checker for appbox. Evaluates the JSON policies in policies/
 * and the risk-tier table against the files in a repository tree.
 *
 *   node scripts/check-policies.mjs                 check this repository
 *   node scripts/check-policies.mjs --root <dir>    check another tree (tests)
 *   node scripts/check-policies.mjs --classify <path>...
 *                                                   print the risk tier of paths
 *
 * Checks:
 *   1. policies/workflow-permissions.json  token scope, action pinning,
 *      pull_request_target, event expressions in run: scripts
 *   2. policies/image-safety.json          no proprietary app in the public
 *      image, signature checks still present and in order, init hook rules
 *   3. policies/repo-target.json           gh write commands name Danathar/appbox
 *   4. policies/no-secrets.json            no private key or secret file committed
 *   5. docs/risk-tiers.md vs risk-config.json  tier table drift
 *   6. the floor: a minimum set of rules hard-coded below, so that editing a
 *      JSON file alone cannot quietly drop the checks that guard Tier 2
 *
 * There is no human merge gate in this repository: agent pull requests merge
 * once the required checks pass, Tier 2 included. These checks are part of
 * that gate. See policies/README.md for what each rule proves and what it
 * does not.
 *
 * Node built-ins only. Exit code 1 when any violation is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

// ---------------------------------------------------------------- helpers

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function matchesAny(globs, file) {
    return globs.some((g) => globToRegExp(g).test(file));
}

/** All files under root as sorted posix relative paths. */
export function walk(root, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, rel), {
        withFileTypes: true,
    })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, r));
        } else if (entry.isFile()) {
            out.push(r);
        }
    }
    return out.sort();
}

function readJson(root, rel, violations) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        violations.push(`${rel}: missing`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        violations.push(`${rel}: invalid JSON (${err.message})`);
        return null;
    }
}

/**
 * Split text into logical lines, joining shell continuations (trailing
 * backslash) so a multi-line command is judged as one command.
 * Returns [{ line, text }] where line is the 1-based first physical line.
 */
export function logicalLines(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let joined = lines[i];
        const start = i + 1;
        while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
            joined = joined.replace(/\\\s*$/, ' ') + lines[++i].trim();
        }
        out.push({ line: start, text: joined });
    }
    return out;
}

/** Shell lines with whole-line comments blanked (line numbers kept). */
export function shellCode(text) {
    return text.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? '' : l));
}

/** Replace quoted strings with "" so log text is not read as a command. */
export const unquoted = (l) => l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

const indentOf = (l) => l.match(/^\s*/)[0].length;
const isBlank = (l) => l.trim() === '';

// ---------------------------------------------- 1. workflow-permissions policy

/** YAML lines with comments removed (a `#` at line start or after a space). */
export function yamlCode(text) {
    return text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''));
}

/** Line index of the top-level key `name:` or -1. */
function topKey(code, name) {
    return code.findIndex((l) => new RegExp(`^${name}\\s*:`).test(l));
}

/**
 * The jobs of a workflow: [{ name, line, permissions }] where permissions is
 * true when the job has its own `permissions:` key.
 */
export function workflowJobs(code) {
    const at = topKey(code, 'jobs');
    if (at === -1) return [];
    const jobs = [];
    let jobIndent = -1;
    for (let j = at + 1; j < code.length; j++) {
        if (isBlank(code[j])) continue;
        const ind = indentOf(code[j]);
        if (ind === 0) break;
        if (jobIndent === -1) jobIndent = ind;
        if (ind === jobIndent) {
            const m = code[j].match(/^\s*([\w-]+)\s*:/);
            if (m) jobs.push({ name: m[1], line: j, permissions: false });
        } else if (jobs.length > 0) {
            const job = jobs[jobs.length - 1];
            const childIndent = job.childIndent ?? (job.childIndent = ind);
            if (ind === childIndent && /^\s*permissions\s*:/.test(code[j])) {
                job.permissions = true;
            }
        }
    }
    return jobs;
}

/**
 * Top-level `permissions:` must exist and grant no write (`write-all` or any
 * `<scope>: write`). Write scopes belong on the job that needs them. A file
 * listed in `jobPermissionsSuffice` may omit the top-level block only if every
 * job declares its own `permissions:`; the top-level write rules still apply
 * if it has one.
 */
export function checkTopLevelPermissions(f, code, policy) {
    const at = topKey(code, 'permissions');
    const v = [];
    if (at === -1) {
        const exempt = (policy.jobPermissionsSuffice ?? []).some((e) => e.file === f);
        if (!exempt) {
            return [
                `${f}: no top-level "permissions:" (the token would get the repository default); use "permissions: {}" and grant scopes per job`,
            ];
        }
        const jobs = workflowJobs(code);
        if (jobs.length === 0) v.push(`${f}: listed in jobPermissionsSuffice but has no jobs`);
        for (const job of jobs.filter((j) => !j.permissions)) {
            v.push(
                `${f}:${job.line + 1}: job "${job.name}" has no "permissions:" and the workflow has no top-level block (exception in jobPermissionsSuffice covers only jobs that declare their own)`,
            );
        }
        return v;
    }
    const inline = code[at].replace(/^permissions\s*:/, '').trim();
    if (/\bwrite/.test(inline)) {
        v.push(`${f}:${at + 1}: top-level permissions grant write ("${inline}")`);
    }
    for (let j = at + 1; j < code.length; j++) {
        if (isBlank(code[j])) continue;
        if (indentOf(code[j]) === 0) break;
        if (/:\s*write\b/.test(code[j])) {
            v.push(
                `${f}:${j + 1}: top-level permissions grant write ("${code[j].trim()}"); grant it on the job that needs it`,
            );
        }
    }
    return v;
}

/** Reject attacker-controlled event expressions inside `run:` scripts. */
export function checkRunExpressions(f, code, policy) {
    const v = [];
    // Contexts are case-insensitive and `a['b']` equals `a.b`.
    const bad = new RegExp(policy.forbiddenRunExpressions, 'i');
    for (let i = 0; i < code.length; i++) {
        const m = code[i].match(/^(\s*(?:-\s+)?)run\s*:\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const body = [m[2]];
        for (let j = i + 1; j < code.length; j++) {
            if (!isBlank(code[j]) && indentOf(code[j]) <= indent) break;
            body.push(code[j]);
        }
        body.forEach((b, k) => {
            for (const e of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
                const norm = e[1].replace(/\[\s*(['"])(.*?)\1\s*\]/g, '.$2');
                if (bad.test(norm)) {
                    v.push(
                        `${f}:${i + 1 + k}: \${{${e[1]}}} in a run script; pass it through env: and use "$VAR"`,
                    );
                }
            }
        });
    }
    return v;
}

/** True when the workflow's `on:` names pull_request_target. */
export function usesPullRequestTarget(code) {
    const at = code.findIndex((l) => /^(?:on|"on"|'on')\s*:/.test(l));
    if (at === -1) return false;
    if (/\bpull_request_target\b/.test(code[at])) return true;
    for (let j = at + 1; j < code.length; j++) {
        if (isBlank(code[j])) continue;
        if (indentOf(code[j]) === 0) break;
        if (/\bpull_request_target\b/.test(code[j])) return true;
    }
    return false;
}

export function checkWorkflows(root, policy, files) {
    const v = [];
    const pin = new RegExp(policy.pinPattern);
    const trusted = new Set(policy.trustedActionOwners ?? []);
    const workflows = files.filter((f) => matchesAny(policy.workflowGlobs, f));

    for (const f of workflows) {
        const raw = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
        const code = yamlCode(raw.join('\n'));

        if (policy.requireTopLevelPermissions) {
            v.push(...checkTopLevelPermissions(f, code, policy));
        }

        code.forEach((l, i) => {
            const m = l.match(/\buses\s*:\s*['"]?([^\s'"]+)/);
            if (!m) return;
            const ref = m[1];
            if (ref.startsWith('./') || ref.startsWith('docker://')) return;
            const [name, version = ''] = ref.split('@');
            const owner = name.split('/')[0];
            if (trusted.has(owner)) return;
            if (!pin.test(version)) {
                v.push(
                    `${f}:${i + 1}: action ${name} must be pinned to a full commit SHA (found "${version || 'no ref'}")`,
                );
            } else if (policy.requireVersionComment && !/#\s*\S/.test(raw[i])) {
                v.push(`${f}:${i + 1}: pinned action ${name} needs a trailing "# vX.Y.Z" comment naming the tag`);
            }
        });

        if (usesPullRequestTarget(code)) {
            const refs = (policy.pullRequestTargetForbidden ?? []).map((p) => new RegExp(p));
            code.forEach((l, i) => {
                for (const re of refs) {
                    if (re.test(l)) {
                        v.push(
                            `${f}:${i + 1}: pull_request_target workflow references the PR head (/${re.source}/); it runs with a write token and must never check out or run PR code`,
                        );
                    }
                }
            });
        }

        if (policy.forbiddenRunExpressions) {
            v.push(...checkRunExpressions(f, code, policy));
        }
    }
    return v;
}

// --------------------------------------------------- 2. image-safety policy

const reOrNull = (p) => (p ? new RegExp(p) : null);

/**
 * The public image must never carry a proprietary app, and the signature
 * checks that make the image and its base trustworthy must stay in place.
 */
export function checkImageSafety(root, policy) {
    const v = [];
    const exists = (rel) => fs.existsSync(path.join(root, rel));
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const pkgs = policy.proprietaryPackages ?? [];
    // A package name, not a longer name (claude-desktop-sync); a version pin
    // (=1.0), an arch (:amd64) or a .deb file name (_1.0_amd64.deb) still counts.
    const pkgRe = (p) =>
        new RegExp(`(?<![\\w.+-])${p.replace(/[.+]/g, '\\$&')}(?![a-zA-Z0-9.+-])`);

    // Package lists: one package per line; a proprietary name is forbidden.
    for (const rel of policy.packageLists ?? []) {
        if (!exists(rel)) {
            v.push(`${rel}: missing (image-safety policy cannot be checked)`);
            continue;
        }
        shellCode(read(rel)).forEach((l, i) => {
            for (const p of pkgs) {
                if (pkgRe(p).test(l)) {
                    v.push(`${rel}:${i + 1}: ${p} is proprietary and must never be baked into the public image`);
                }
            }
        });
    }

    // Build scripts: an install command naming a proprietary package fails
    // unless it is a simulation (apt-get install -s, used to list deps).
    const installRe = new RegExp(policy.installPattern);
    const simulateRe = new RegExp(policy.simulatePattern);
    for (const rel of policy.imageBuildFiles ?? []) {
        if (!exists(rel)) {
            v.push(`${rel}: missing (image-safety policy cannot be checked)`);
            continue;
        }
        const code = shellCode(read(rel)).join('\n');
        for (const { line, text } of logicalLines(code)) {
            const t = unquoted(text);
            if (!installRe.test(t)) continue;
            // Judge each command of the line on its own.
            for (const seg of t.split(/;|&&|\|\||\|/)) {
                if (!installRe.test(seg) || simulateRe.test(seg)) continue;
                for (const p of pkgs) {
                    if (pkgRe(p).test(seg)) {
                        v.push(`${rel}:${line}: installs ${p}, which is proprietary and must never be baked into the public image`);
                    }
                }
            }
        }
    }

    // Forbidden options anywhere in the listed files, comments excluded.
    const forb = policy.forbiddenOptions ?? { files: [], patterns: [] };
    const forbRes = forb.patterns.map((p) => new RegExp(p));
    for (const rel of forb.files) {
        if (!exists(rel)) {
            v.push(`${rel}: missing (image-safety policy cannot be checked)`);
            continue;
        }
        const code = rel.endsWith('.yml') || rel.endsWith('.yaml') ? yamlCode(read(rel)) : shellCode(read(rel));
        code.forEach((l, i) => {
            for (const re of forbRes) {
                if (re.test(l)) {
                    v.push(`${rel}:${i + 1}: forbidden option /${re.source}/ weakens signature or package verification`);
                }
            }
        });
    }

    // Ordered sequences: each pattern must appear on a code line, on or after
    // the line of the previous one. Proves presence and order, not correctness.
    for (const seq of policy.requiredSequences ?? []) {
        if (!exists(seq.file)) {
            v.push(`${seq.file}: missing (required sequence "${seq.name}" cannot be checked)`);
            continue;
        }
        const yaml = /\.ya?ml$/.test(seq.file);
        const code = yaml ? yamlCode(read(seq.file)) : shellCode(read(seq.file));
        let from = 0;
        for (const step of seq.steps) {
            const re = new RegExp(step.pattern);
            // `last: true` anchors on the final occurrence (the last install).
            const hits = code.flatMap((l, i) => (i >= from && re.test(l) ? [i] : []));
            const at = hits.length === 0 ? -1 : step.last ? hits[hits.length - 1] : hits[0];
            if (at === -1) {
                const anywhere = code.findIndex((l) => re.test(l));
                v.push(
                    anywhere === -1
                        ? `${seq.file}: "${seq.name}": ${step.why} is missing (/${step.pattern}/)`
                        : `${seq.file}:${anywhere + 1}: "${seq.name}": ${step.why} is out of order (must not come before line ${from + 1})`,
                );
                break;
            }
            // The next step may share this line (one sed sets image= and
            // pull=), but may not come before it.
            from = at;
        }
    }

    // Init hooks: install only, never upgrade, always exit 0.
    for (const hook of policy.initHooks ?? []) {
        if (!exists(hook.file)) {
            v.push(`${hook.file}: missing (init-hook policy cannot be checked)`);
            continue;
        }
        const code = shellCode(read(hook.file));
        const upgrade = reOrNull(hook.forbiddenPattern);
        code.forEach((l, i) => {
            if (upgrade && upgrade.test(unquoted(l))) {
                v.push(`${hook.file}:${i + 1}: an init hook must never upgrade (an app may be starting); upgrades belong to host/appbox-update`);
            }
        });
        const last = [...code].reverse().find((l) => !isBlank(l));
        if (hook.lastCommand && (last ?? '').trim() !== hook.lastCommand) {
            v.push(`${hook.file}: last command must be "${hook.lastCommand}" (a failing init hook stops the box and every app in it)`);
        }
        for (const p of hook.forbiddenShellOptions ?? []) {
            const re = new RegExp(p);
            code.forEach((l, i) => {
                if (re.test(l)) v.push(`${hook.file}:${i + 1}: /${p}/ would let one failed command abort the hook`);
            });
        }
    }

    for (const key of policy.publicKeys ?? []) {
        if (!exists(key.file)) {
            v.push(`${key.file}: missing (part of the image trust chain)`);
        } else if (!read(key.file).includes(key.mustContain)) {
            v.push(`${key.file}: does not look like a public key (expected "${key.mustContain}")`);
        }
    }
    return v;
}

// ------------------------------------------------------ 3. repo-target policy

export function findWriteCommands(text, writeRe) {
    return [...text.matchAll(new RegExp(writeRe, 'g'))].map((m) => m[0]);
}

/**
 * gh write commands must not name another repository anywhere scanned, and
 * in the files matching requireFlagGlobs they must carry -R/--repo
 * Danathar/appbox on the same logical line.
 */
export function checkRepoTarget(root, policy, files) {
    const v = [];
    const repoRe = new RegExp(policy.repoFlagPattern);
    const forbidden = policy.forbiddenPatterns.map((p) => new RegExp(p));
    const scanned = files.filter(
        (f) => matchesAny(policy.scanGlobs, f) && !matchesAny(policy.excludeGlobs ?? [], f),
    );
    for (const f of scanned) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        const strict = matchesAny(policy.requireFlagGlobs ?? [], f);
        for (const { line, text: t } of logicalLines(text)) {
            for (const re of forbidden) {
                if (re.test(t)) {
                    v.push(`${f}:${line}: names another repository for a write (${re.source}); work stays in ${policy.repo}`);
                }
            }
            if (!strict) continue;
            const cmds = findWriteCommands(t, policy.writeCommandPattern);
            if (cmds.length > 0 && !repoRe.test(t)) {
                v.push(`${f}:${line}: "${cmds[0]}" without -R ${policy.repo} (a bare gh command targets whatever repository the clone defaults to)`);
            }
        }
    }
    return v;
}

// ------------------------------------------------------- 4. no-secrets policy

/**
 * No private key material or secret files in the tree. Reports the path
 * only, never the matching content.
 */
export function checkNoSecrets(root, policy, files) {
    const v = [];
    const nameRes = policy.forbiddenFileGlobs ?? [];
    const contentRes = (policy.forbiddenContentPatterns ?? []).map((p) => new RegExp(p));
    for (const f of files) {
        if (matchesAny(nameRes, f) && !matchesAny(policy.allowFileGlobs ?? [], f)) {
            v.push(`${f}: secret-looking file must not be committed (remove it and rotate whatever it held)`);
            continue;
        }
        const buf = fs.readFileSync(path.join(root, f));
        if (buf.length > (policy.maxScanBytes ?? 1048576)) continue;
        const text = buf.toString('utf8');
        for (const re of contentRes) {
            if (re.test(text)) {
                v.push(`${f}: contains private key material (/${re.source}/); remove it and rotate the key`);
                break;
            }
        }
    }
    return v;
}

// ------------------------------------------------------ 5. risk-tier drift

/** The tier of a path: the highest-numbered (riskiest) tier that matches. */
export function classify(config, file) {
    let best = null;
    for (const t of config.tiers) {
        if (matchesAny(t.paths, file) && (best === null || t.tier > best.tier)) {
            best = t;
        }
    }
    return best ?? config.tiers.find((t) => t.tier === config.default_tier);
}

const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export function parseTierTable(markdown) {
    const rows = [];
    for (const raw of markdown.split(/\r?\n/)) {
        if (!/^\|\s*\d+\s*\|/.test(raw)) continue;
        const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.length !== 5) {
            rows.push({ malformed: raw });
            continue;
        }
        rows.push({
            tier: Number(cells[0]),
            name: cells[1],
            paths: ticks(cells[2]),
            commands: ticks(cells[3]),
            scrutiny: ticks(cells[4])[0] ?? cells[4],
        });
    }
    return rows;
}

const diff = (a, b) => a.filter((x) => !b.includes(x));

export function checkRiskTiers(config, markdown) {
    const v = [];
    const doc = 'docs/risk-tiers.md';
    const json = 'risk-config.json';
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
        return [`${json}: "tiers" must be a non-empty array`];
    }
    const nums = config.tiers.map((t) => t.tier);
    if (new Set(nums).size !== nums.length) v.push(`${json}: duplicate tier numbers`);
    if (!nums.includes(config.default_tier)) {
        v.push(`${json}: default_tier ${config.default_tier} is not a defined tier`);
    }
    const rows = parseTierTable(markdown);
    for (const r of rows.filter((r) => r.malformed)) {
        v.push(`${doc}: malformed tier row "${r.malformed}" (need 5 columns)`);
    }
    const docRows = rows.filter((r) => !r.malformed);
    for (const t of config.tiers) {
        const row = docRows.find((r) => r.tier === t.tier);
        if (!row) {
            v.push(`${doc}: tier ${t.tier} (${t.name}) is in ${json} but not in the table`);
            continue;
        }
        if (row.name !== t.name) {
            v.push(`${doc}: tier ${t.tier} is named "${row.name}", ${json} says "${t.name}"`);
        }
        const sets = [
            ['paths', row.paths, t.paths],
            ['required commands', row.commands, t.required_commands],
        ];
        for (const [label, d, j] of sets) {
            for (const x of diff(j, d)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in ${json} but not in the table`);
            }
            for (const x of diff(d, j)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in the table but not in ${json}`);
            }
        }
        if (row.scrutiny !== t.scrutiny) {
            v.push(`${doc}: tier ${t.tier} scrutiny is "${row.scrutiny}", ${json} says "${t.scrutiny}"`);
        }
    }
    for (const r of docRows) {
        if (!nums.includes(r.tier)) v.push(`${doc}: tier ${r.tier} is in the table but not in ${json}`);
    }
    return v;
}

// ------------------------------------------------------------- 6. the floor

/**
 * The minimum the policies must keep. Every agent pull request merges once
 * checks pass, so a policy JSON edit that drops one of these would otherwise
 * merge as quietly as any other Tier 1 change. Removing one now means editing
 * this script and its tests too, which is a visible change.
 */
export const FLOOR = {
    tier2Paths: [
        'host/**',
        'hosts/**',
        'distrobox.ini',
        'ContainerFiles/**',
        'scripts/appbox.sh',
        'scripts/claude-desktop-sync',
        'packages/**',
        'keys/**',
        'cosign.pub',
        '.github/workflows/build-appbox.yml',
        '.claude/settings.json',
        '.claude/hooks/**',
    ],
    proprietaryPackages: ['claude-desktop'],
    packageLists: ['packages/appbox.packages'],
    imageBuildFiles: ['scripts/appbox.sh', 'ContainerFiles/appbox'],
    sequences: ['build-signing', 'host-rebuild', 'image-no-proprietary'],
    initHooks: ['scripts/claude-desktop-sync'],
    publicKeys: ['cosign.pub', 'keys/ublue-os-toolboxes.pub'],
};

export function checkFloor({ workflows, image, config }) {
    const v = [];
    const where = 'policy floor (scripts/check-policies.mjs FLOOR)';
    if (workflows) {
        if (workflows.requireTopLevelPermissions !== true) {
            v.push(`policies/workflow-permissions.json: requireTopLevelPermissions must stay true (${where})`);
        }
        if (workflows.pinPattern !== '^[0-9a-f]{40}$') {
            v.push(`policies/workflow-permissions.json: pinPattern must stay "^[0-9a-f]{40}$" (${where})`);
        }
        if ((workflows.trustedActionOwners ?? []).length > 0) {
            v.push(`policies/workflow-permissions.json: trustedActionOwners must stay empty; every action is pinned (${where})`);
        }
        if (!workflows.forbiddenRunExpressions) {
            v.push(`policies/workflow-permissions.json: forbiddenRunExpressions must stay set (${where})`);
        }
        const exempt = (workflows.jobPermissionsSuffice ?? []).map((e) => e.file);
        for (const f of exempt) {
            if (f !== '.github/workflows/build-appbox.yml') {
                v.push(`policies/workflow-permissions.json: jobPermissionsSuffice may only list build-appbox.yml, found ${f} (${where})`);
            }
        }
    }
    if (image) {
        const need = (label, have, list) => {
            for (const x of list) {
                if (!(have ?? []).includes(x)) {
                    v.push(`policies/image-safety.json: ${label} must include "${x}" (${where})`);
                }
            }
        };
        need('proprietaryPackages', image.proprietaryPackages, FLOOR.proprietaryPackages);
        need('packageLists', image.packageLists, FLOOR.packageLists);
        need('imageBuildFiles', image.imageBuildFiles, FLOOR.imageBuildFiles);
        need('requiredSequences', (image.requiredSequences ?? []).map((s) => s.name), FLOOR.sequences);
        need('initHooks', (image.initHooks ?? []).map((h) => h.file), FLOOR.initHooks);
        need('publicKeys', (image.publicKeys ?? []).map((k) => k.file), FLOOR.publicKeys);
    }
    if (config && Array.isArray(config.tiers)) {
        const top = Math.max(...config.tiers.map((t) => t.tier));
        const tier = config.tiers.find((t) => t.tier === top);
        for (const p of FLOOR.tier2Paths) {
            if (!tier.paths.includes(p)) {
                v.push(`risk-config.json: "${p}" must stay in the highest tier (${where})`);
            }
        }
    }
    return v;
}

// ------------------------------------------------------------------- main

export function checkAll(root) {
    const violations = [];
    const files = walk(root);

    const workflows = readJson(root, 'policies/workflow-permissions.json', violations);
    if (workflows) violations.push(...checkWorkflows(root, workflows, files));

    const image = readJson(root, 'policies/image-safety.json', violations);
    if (image) violations.push(...checkImageSafety(root, image));

    const target = readJson(root, 'policies/repo-target.json', violations);
    if (target) violations.push(...checkRepoTarget(root, target, files));

    const secrets = readJson(root, 'policies/no-secrets.json', violations);
    if (secrets) violations.push(...checkNoSecrets(root, secrets, files));

    const config = readJson(root, 'risk-config.json', violations);
    const docPath = path.join(root, 'docs/risk-tiers.md');
    if (!fs.existsSync(docPath)) {
        violations.push('docs/risk-tiers.md: missing');
    } else if (config) {
        violations.push(...checkRiskTiers(config, fs.readFileSync(docPath, 'utf8')));
    }

    violations.push(...checkFloor({ workflows, image, config }));
    return violations;
}

export function main(argv, out = console) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let root = path.resolve(here, '..');
    const rootIdx = argv.indexOf('--root');
    if (rootIdx !== -1) root = path.resolve(argv[rootIdx + 1]);

    const classifyIdx = argv.indexOf('--classify');
    if (classifyIdx !== -1) {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'risk-config.json'), 'utf8'));
        for (const p of argv.slice(classifyIdx + 1)) {
            const t = classify(config, p.replace(/^\.\//, ''));
            out.log(`${p}: tier ${t.tier} (${t.name}), scrutiny: ${t.scrutiny}`);
        }
        return 0;
    }

    const violations = checkAll(root);
    if (violations.length > 0) {
        out.error(`check-policies: ${violations.length} violation(s)`);
        for (const x of violations) out.error(`  ${x}`);
        return 1;
    }
    out.log('check-policies: all policies satisfied');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
