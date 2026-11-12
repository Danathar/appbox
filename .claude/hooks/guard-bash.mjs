#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool (wired up in .claude/settings.json).
//
// Threat model: this hook stops an agent that is following the rules in
// AGENTS.md from carelessly or accidentally damaging the machine it runs on,
// or the live `main` branch. It is NOT a sandbox against deliberate
// obfuscation (eval of built strings, variables that hold a command, scripts
// written to disk and then run). The real boundaries are review, the branch
// ruleset on `main`, and the token's repository access.
//
// Why: `main` is live. Every enrolled machine fast-forwards its checkout to it
// and runs host/appbox-update from it on the next timer run, and the developer's
// machine is usually one of them, with the real `apps` box holding Signal and
// Claude Desktop. host/appbox-update deletes and recreates that box and
// upgrades the apps inside it; host/install enables the timer that runs it. An
// agent that runs either "to see what happens" can cut off an open app,
// rebuild the user's real box, or change their notification state.
//
// Protocol (https://docs.anthropic.com/en/docs/claude-code/hooks): the hook
// receives JSON on stdin ({ tool_name, tool_input: { command } }). Exit 0 lets
// the call proceed; exit 2 blocks it and feeds stderr back to the model. Any
// failure inside the hook blocks (fail closed).
//
// What is blocked:
//   The repository's machine scripts
//   - Running host/appbox-update (also as ./host/appbox-update, by absolute
//     path, ~/claude/appbox/host/appbox-update, behind env/timeout/nohup/exec
//     and other wrappers, through bash/sh/zsh/... with or without -c, source,
//     `.`, bats, systemd-run, find -exec, distrobox-host-exec or inside
//     `distrobox enter`). The one exemption is `--show-config` as the first
//     argument: the script prints its settings and exits before it touches
//     git, podman or the box. The documented throwaway-ini test
//     (APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini ... --force) is NOT exempt:
//     the hook cannot see what the ini says (it may name the real box and
//     image, or be written in the same command), and even a run that stops at
//     the failed pull first reads the real box and writes notification state
//     under ~/.local/state/appbox. That test is for the owner to run by hand.
//   - Running host/install (symlinks the units and enables the timer),
//     scripts/appbox.sh (image build step) and scripts/claude-desktop-sync
//     (box-start init hook, which installs a package).
//   - Behind any other program (`setarch x86_64 host/appbox-update`,
//     `prlimit ... host/install`, `script -qc '...'`), a machine script's path
//     is read as the command that program runs, with the same --show-config
//     exception; behind programs that only read or inspect files
//     (FILE_OPERAND_PROGRAMS: shellcheck, wc, cp, ls, gh, ...) it is data.
//   - A shell's own options end at its first operand or `--`: `bash host/install
//     -n` runs host/install with $1=-n, so only `bash -n FILE` is a syntax check.
//   - `bash -n FILE` (syntax check), shellcheck, cat, grep and other readers of
//     those files are fine.
//   Owner switch: when Claude Code itself was started with
//   APPBOX_OWNER_SESSION=1 in its environment (`APPBOX_OWNER_SESSION=1 claude`,
//   the owner setting up or testing a machine per docs/install.md), the hook's
//   own process sees it and allows running host/appbox-update and host/install
//   (directly or through systemd-run), `distrobox assemble create|rm`,
//   `distrobox stop`, and `systemctl --user` changes to appbox units including
//   daemon-reload. Setting the variable inside a command (inline or export)
//   does nothing. Never relaxed by it: secret reads, force pushes and pushes to
//   main, history rewrites, prunes and --all removals, the `apps` box and image
//   removals, distrobox rm/upgrade, pkill of the apps, deleting app data,
//   sudo, rpm-ostree layering and apt/dpkg changes.
//   Boxes, containers and images
//   - distrobox rm|stop|upgrade, and their distrobox-rm/-stop/-upgrade forms, for
//     any box. `distrobox assemble rm`, and `distrobox assemble create` unless
//     it is a --dry-run: the repo's ini sets replace=true, so creating from it
//     deletes an existing box first.
//   - `distrobox enter` with no command (an interactive shell nobody sees);
//     a command given after `--` or `-e` is checked like any other command.
//     distrobox-host-exec and `toolbox run` likewise. toolbox rm/rmi.
//   - podman/docker/nerdctl/buildah rm, rmi, stop, kill, restart, pause of the
//     `apps` box or a ghcr.io/danathar/appbox image, any of them with
//     -a/--all or a name built by a substitution, every prune and
//     `system reset`, `volume rm --all`, and `run|create --replace` of `apps`.
//     `exec` into `apps` checks the command it runs.
//     Targets that xargs fills in at run time count as unseen and are refused.
//   - pkill/killall of Signal or Claude (distrobox shares the host PID
//     namespace, so that kills the user's open app).
//   - rm, rmdir, shred, unlink, mv or truncate of the live app data
//     (~/.config/Signal, ~/.config/Claude), ~/.local/state/appbox, the
//     exported apps-* launchers, ~/.config/systemd/user, or the checkout
//     ~/claude/appbox itself.
//   Host changes
//   - systemctl start/stop/enable/disable/restart/mask/... of any appbox unit,
//     and `systemctl --user daemon-reload` (it loads unit files from the
//     checkout; the owner does that on each machine after a merge).
//   - sudo, doas, pkexec, run0, su, runuser, anywhere in a wrapper chain.
//   - rpm-ostree and bootc subcommands other than status (no layering).
//   - apt, apt-get, apt-mark and dpkg subcommands that change packages (on the
//     host or inside a box); queries are fine.
//   Secrets
//   - Reading a secret file with a program that prints it (cat, less, head,
//     tail, sed, awk, grep, strings, xxd, base64, jq, an editor, ...), as an
//     argument or on stdin: .env and .env.*, *.key (cosign.key), *.pem, *.p12,
//     *.jks, SSH private keys and anything under ~/.ssh other than *.pub,
//     ~/.config/gh, ~/.config/appbox-signing, ~/.docker/config.json, netrc
//     files, ~/.aws/credentials, kubeconfigs. hosts/*.env are plain settings,
//     not secrets, and stay readable. Moving a secret without reading it
//     (`gh secret set NAME < cosign.key`, cp, ls -l, wc -c) is fine.
//   git
//   - git push with --force/-f/--force-with-lease/--force-if-includes, a `+`
//     refspec, --mirror, --all, --delete/-d, --prune, a `:ref` refspec, --repo,
//     no explicit remote and branch, a bare HEAD (which may be main), or any
//     refspec whose destination is main. Long options are matched by prefix,
//     since git accepts abbreviations (`--forc`).
//   - git reset --hard, git filter-branch, git filter-repo.
//   - `git -c` keys and GIT_* variables that redirect a push or make git run
//     a program, and options that turn a pre-approved read (git diff/log/show)
//     into a file write or program run (--output, --no-index, --ext-diff, ...).
//   - git diff/show/log/blame/grep/cat-file naming a secret file.
//   node
//   - `node --test` with options outside the test-runner allowlist, and node
//     with NODE_OPTIONS or another NODE_* variable set.
//
// Parsing: the command line is read by the shared shell reader
// (shell-reader.mjs, byte-identical across the repositories that carry this
// guard; see .claude/hooks/tests/shell-reader.test.mjs). It splits segments on
// && || ; | & newlines, subshells and command substitutions, resolves quotes,
// and looks through wrappers (env, timeout, xargs, nohup, exec, flock, watch,
// ...) to the command they run. Shell -c strings, eval, watch, flock -c and
// `find -exec` are checked recursively. A command name spelled with braces or
// wildcards (`{git,}`, `/usr/bin/g?t`) is read the way the shell reads it.
// Quoted text handed to echo/printf/grep is data. Behind any other program,
// each later word that names a command checked here is checked from there on,
// so `setarch x86_64 distrobox rm apps` is caught; a side effect is that a
// `gh ... --body "..."` whose text reads like a blocked command is refused, so
// use --body-file.

import { basename, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Reading the command line as the shell would is shared with the other
// repositories that carry this guard; see shell-reader.mjs.
import {
    ARGUMENT_ONLY_PROGRAMS, BUDGET_MS, COMMAND_STRING_SEPARATORS, commandNameReader, commandStrings, EXEC_GIT_CONFIG,
    expandWrapperOptions, extractSubstitutions, FIND_EXEC, fishScripts, firstWord, GIT_EXEC_OPTION, GIT_SHORT_UPLOAD_PACK,
    GIT_UPLOAD_PACK_OPTION, GIT_UPLOAD_PACK_SUBCOMMANDS, globMatches, isAssignment, KEYWORDS, MAX_UNLISTED_INNER,
    OverBudget, REFUSED_GIT_OPTION, RISKY_GIT_CONFIG, riskyEnv, SAFE_ENV, SHELLS, spend, startBudget, tokenize, unquoted,
    WRAPPERS, wrapperTarget,
} from './shell-reader.mjs';

export { BUDGET_MS, tokenize } from './shell-reader.mjs';

const GUIDANCE =
    'Hard rules for appbox (AGENTS.md): main is live on every enrolled machine, so never force-push or push to main; ' +
    'never run host/appbox-update (except --show-config) or host/install, never remove, stop or recreate a box, ' +
    'never touch an open app, and never read secrets. Test the update script with `bats tests/unit` and `tests/e2e`; ' +
    'tests on a real machine are run by the owner.';

const block = (reason) => ({ blocked: true, reason: `${reason}\n${GUIDANCE}` });

// The owner switch. The owner sets up and tests machines with Claude Code
// (docs/new-machine-prompt.md, docs/install.md), which needs a few of the
// commands refused below. A session the owner starts as
// `APPBOX_OWNER_SESSION=1 claude` passes that variable to this hook's own
// process, because hooks inherit Claude Code's environment. A Bash call cannot
// set it here: an inline `APPBOX_OWNER_SESSION=1 cmd` or an `export` only
// reaches the command, never this process, and the hook never reads the
// command's assignments for it. Read on every call so tests can toggle it.
export const OWNER_ENV = 'APPBOX_OWNER_SESSION';
const ownerSession = () => process.env[OWNER_ENV] === '1';
const OWNER_HINT =
    ` In a session the owner started as \`${OWNER_ENV}=1 claude\` (machine setup, docs/install.md) this is allowed; ` +
    'an agent cannot turn that on.';

// ---------------------------------------------------------------------------
// The repository's machine scripts
// ---------------------------------------------------------------------------

const GLOB_CHARS = /[*?[]/;

/** Whether `part` (one path component) is `name`, or a pattern the shell could expand to it. */
function partIs(part, name) {
    if (part === name) return true;
    return GLOB_CHARS.test(part) && globMatches(part, name);
}

/**
 * Which machine script this word names, if any: 'updater' (host/appbox-update),
 * 'installer' (host/install), 'build' (scripts/appbox.sh), 'hook'
 * (claude-desktop-sync), 'unknown' for a file name the hook cannot see
 * (`$X`, `{a,b}`), or null. `operand` is true when a shell will open the word
 * as a script file (`bash install`), where a bare `install` is the file in the
 * working directory rather than coreutils' install on the PATH.
 */
export function machineScript(word, operand = false) {
    const w = String(word).replace(/\/+$/, '');
    const slash = w.lastIndexOf('/');
    const name = w.slice(slash + 1);
    const dir = slash === -1 ? '' : w.slice(0, slash);
    if (/[{}$`]/.test(name)) return 'unknown';
    if (partIs(name, 'appbox-update')) return 'updater';
    if (partIs(name, 'appbox.sh')) return 'build';
    if (partIs(name, 'claude-desktop-sync')) return 'hook';
    if (partIs(name, 'install')) {
        if (operand && dir === '') return 'installer';
        const parent = basename(dir || '.');
        if (dir !== '' && (parent === '.' || partIs(parent, 'host'))) return 'installer';
    }
    return null;
}

const SCRIPT_WHY = {
    updater:
        'host/appbox-update deletes and recreates the `apps` box and upgrades the apps in it, on the real machine. ' +
        'Only `host/appbox-update --show-config` (settings, no changes) is allowed. The throwaway-ini test in ' +
        'docs/working-on-the-repo.md is not exempt: the hook cannot check what the ini names, and the run still reads ' +
        'the real box and writes notification state. Use `bats tests/unit` and `tests/e2e`, or ask the owner to run it.',
    installer:
        'host/install symlinks the units into ~/.config/systemd/user, reloads systemd and enables the update timer on ' +
        'this machine. The owner runs it when enrolling a machine.',
    build: 'scripts/appbox.sh is the image build step; it runs inside the CI image build (ContainerFiles/appbox), never on a machine.',
    hook: 'claude-desktop-sync is the box-start init hook; it installs a package and runs only inside a box, from distrobox-init.',
    unknown: 'the script name is built from a variable or brace group the hook cannot read; spell the path out.',
};

/** The refusal for running a machine script with `scriptArgs`, or null for the allowed `--show-config`. */
function checkScriptRun(kind, scriptArgs, what, sourced = false) {
    if (kind === 'updater' && !sourced && scriptArgs[0] === '--show-config') return null;
    const ownerMay = (kind === 'updater' || kind === 'installer') && !sourced;
    if (ownerMay && ownerSession()) return null;
    return block(`Blocked: ${what}. ${SCRIPT_WHY[kind]}${ownerMay ? OWNER_HINT : ''}`);
}

/** The first machine script a list of words names (and its index), as a shell would open it. */
function scriptOperand(words, operand = true) {
    for (let i = 0; i < words.length; i++) {
        const kind = machineScript(words[i], operand);
        if (kind) return { kind, at: i };
    }
    return null;
}

/** True if a tokenized segment names a machine script as an argument or reads one with `<`. */
function segmentReadsScript(seg) {
    return seg.some((a) => machineScript(a, true)) || (seg.stdinFrom !== undefined && machineScript(seg.stdinFrom, true));
}

/** True if a command line (a substitution body) reads or names a machine script. */
function readsScript(commandLine) {
    return tokenize(commandLine).some(segmentReadsScript);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Programs that print (or open for display) the files they are given.
const READERS = new Set([
    'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'bat', 'batcat', 'view', 'sed', 'awk', 'gawk', 'mawk',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'strings', 'xxd', 'od', 'hexdump', 'hd', 'base64', 'base32', 'cut', 'sort',
    'uniq', 'diff', 'cmp', 'comm', 'paste', 'fold', 'fmt', 'pr', 'column', 'jq', 'yq', 'vi', 'vim', 'nvim', 'nano',
    'emacs', 'ed', 'ex', 'dd', 'iconv', 'tr', 'rev', 'expand', 'unexpand', 'look',
]);
// Sample secret file names a wildcard is matched against (`cat *.key`).
const SECRET_SAMPLES = ['cosign.key', '.env', '.env.local', 'id_rsa', 'id_ed25519', 'server.pem', 'cert.p12'];

/** Whether a path names a secret file (see the header). */
export function isSecretPath(word) {
    const w = String(word).replace(/\/+$/, '');
    const name = w.slice(w.lastIndexOf('/') + 1);
    if (name === '.env' || name.startsWith('.env.')) return true;
    if (/\.(key|pem|p12|pfx|jks|keystore)$/i.test(name)) return true;
    if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(name)) return true;
    if (/(^|\/)\.ssh(\/|$)/.test(w) && !name.endsWith('.pub')) return true;
    if (/(^|\/)\.config\/(gh|appbox-signing)(\/|$)/.test(w)) return true;
    if (/(^|\/)\.docker\/config\.json$/.test(w) || /(^|\/)\.aws\/credentials$/.test(w)) return true;
    if (/(^|\/)\.kube\/config$/.test(w) || /^kubeconfig/.test(name)) return true;
    if (name === '.netrc' || name === '_netrc' || name === '.git-credentials') return true;
    if (GLOB_CHARS.test(name) && !/^\*+$/.test(name)) return SECRET_SAMPLES.some((s) => globMatches(name, s));
    return false;
}

/** The secret file a word names, as an operand or the value of `--opt=FILE` / `if=FILE`, or undefined. */
function secretIn(word) {
    if (isSecretPath(word)) return word;
    const eq = word.indexOf('=');
    if (eq !== -1 && isSecretPath(word.slice(eq + 1))) return word.slice(eq + 1);
    return undefined;
}

// grep-like programs whose first operand is the search pattern, not a file
// (`grep -rn cosign.key docs` searches docs for the text "cosign.key").
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);

/** The words of a reader's arguments that it opens as files (options and values left in; they are harmless). */
function readerFiles(cmd, args) {
    if (!PATTERN_FIRST.has(cmd)) return args;
    const out = [];
    let patternGiven = false;
    let skippedPattern = false;
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (['-e', '--regexp'].includes(a)) {
            patternGiven = true;
            k++;
            continue;
        }
        if (['-f', '--file'].includes(a)) {
            patternGiven = true;
            out.push(args[k + 1] ?? '');
            k++;
            continue;
        }
        if (/^-e./.test(a) || a.startsWith('--regexp=')) {
            patternGiven = true;
            continue;
        }
        if (!a.startsWith('-') && !patternGiven && !skippedPattern) {
            skippedPattern = true;
            continue;
        }
        out.push(a);
    }
    return out;
}

function checkReader(cmd, args, stdinFrom) {
    const named = readerFiles(cmd, args).map(secretIn).find((s) => s !== undefined) ?? (stdinFrom !== undefined ? secretIn(stdinFrom) : undefined);
    if (named === undefined) return null;
    return block(
        `Blocked: \`${cmd}\` would print the secret file ${named} into the transcript. Never read secrets; move them ` +
            'without looking (`gh secret set NAME -R Danathar/appbox < FILE`, cp, install -m 600), check them with ' +
            'ls -l, test -f or wc -c, and verify a key through its public half (`cosign public-key --key FILE`).'
    );
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function checkGit(args, inlineEnv = {}, exported = {}) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        const a = args[i];
        let configKey = null;
        if (a === '-c' || a === '--config-env') configKey = (args[i + 1] ?? '').split('=')[0];
        else if (a.startsWith('--config-env=')) configKey = a.slice(13).split('=')[0];
        if (configKey !== null && RISKY_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` could redirect pushes or credentials.`);
        }
        if (configKey !== null && EXEC_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` makes git run a program or read other config.`);
        }
        if (a.startsWith('--exec-path=')) return block('Blocked: `git --exec-path=DIR` runs git commands from another directory.');
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const env = { ...exported, ...inlineEnv };
    if (sub === 'push') {
        const pushKey = Object.keys(env).find((k) => /^(GIT_CONFIG_|GIT_SSH)/i.test(k));
        if (pushKey) return block(`Blocked: \`git push\` with ${pushKey}= could redirect the push.`);
    }
    const envKey = riskyEnv(env);
    if (envKey) {
        return block(
            `Blocked: \`git\` with ${envKey} set; it can make git run a program, write a file or read another repository. ` +
                'Only GIT_AUTHOR_*/GIT_COMMITTER_* identity and PAGER/GIT_PAGER/GIT_EDITOR=cat|true are allowed.'
        );
    }
    const refused = args.find((a) => REFUSED_GIT_OPTION.test(a)) ?? (sub === 'grep' ? rest.find((a) => /^-[a-zA-Z]*O/.test(a)) : undefined);
    if (refused !== undefined) {
        return block(
            `Blocked: \`git ${sub ?? ''} ${refused}\` writes a file, reads outside the repository or runs a program. ` +
                'Read the output on stdout instead.'
        );
    }
    if (GIT_UPLOAD_PACK_SUBCOMMANDS.has(sub)) {
        const program = rest.find(
            (a) =>
                GIT_UPLOAD_PACK_OPTION.test(a) ||
                ((sub === 'ls-remote' || sub === 'archive') && GIT_EXEC_OPTION.test(a)) ||
                ((sub === 'clone' || sub === 'ls-remote') && GIT_SHORT_UPLOAD_PACK.test(a))
        );
        if (program !== undefined) return block(`Blocked: \`git ${sub} ${program}\` runs the program it names.`);
    }
    if (['diff', 'show', 'log', 'blame', 'grep', 'cat-file'].includes(sub)) {
        const secret = rest.map((a) => secretIn(a.replace(/^[^:]*:/, ''))).find((s) => s !== undefined);
        if (secret !== undefined) return block(`Blocked: \`git ${sub}\` would print the secret file ${secret}.`);
    }
    if (sub === 'push') return checkGitPush(rest);
    if (sub === 'reset' && rest.some((a) => /^--ha(?:rd?)?$/.test(a))) {
        return block(
            'Blocked: `git reset --hard` throws away uncommitted work and can rewind a branch. Use `git stash`, ' +
                '`git switch -c <branch> origin/main` or `git restore <path>` for the one file you mean.'
        );
    }
    if (sub === 'filter-branch' || sub === 'filter-repo') {
        return block(`Blocked: \`git ${sub}\` rewrites history. main is never rewritten (docs/working-on-the-repo.md).`);
    }
    if (sub === 'config') return checkGitConfig(rest);
    return null;
}

/** Writes to push-redirecting config keys (`git config remote.origin.url ...`). */
function checkGitConfig(rest) {
    const readOnly = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
    if (rest.some((a) => readOnly.includes(a))) return null;
    const valueFlags = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];
    const positionals = [];
    for (let k = 0; k < rest.length; k++) {
        if (valueFlags.includes(rest[k])) k++;
        else if (!rest[k].startsWith('-')) positionals.push(rest[k]);
    }
    if (positionals.length && ['get', 'list'].includes(positionals[0])) return null;
    let modifies = false;
    if (positionals.length && ['set', 'unset', 'replace-all', 'add', 'rename-section', 'remove-section', 'edit'].includes(positionals[0])) {
        if (positionals[0] === 'edit') return block('Blocked: `git config edit` could redirect pushes or credentials.');
        positionals.shift();
        modifies = true;
    }
    modifies = modifies || positionals.length > 1 || rest.some((a) => /^--(unset|unset-all|add|replace-all|remove-section|rename-section)$/.test(a));
    if (modifies && positionals.some((p) => RISKY_GIT_CONFIG.test(p) || RISKY_GIT_CONFIG.test(`${p}.x`))) {
        return block(`Blocked: \`git config ${positionals[0]}\` write could redirect pushes or credentials.`);
    }
    if (rest.includes('--edit') || rest.includes('-e')) return block('Blocked: `git config --edit` could redirect pushes or credentials.');
    return null;
}

// Long `git push` options that force, mirror, push everything, delete or
// redirect. git accepts any unambiguous abbreviation of a long option, so a word
// that is a prefix (three or more characters with the dashes) of one is refused.
const PUSH_DANGER = [
    ['--force', 'force push'], ['--force-with-lease', 'force push'], ['--force-if-includes', 'force push'],
    ['--mirror', '`git push --mirror` overwrites every ref on the remote, main included'],
    ['--all', '`git push --all` pushes every local branch, main included'],
    ['--branches', '`git push --branches` pushes every local branch, main included'],
    ['--delete', 'deleting remote refs'], ['--prune', 'deleting remote refs (--prune)'],
    ['--repo', '`git push --repo` redirects the push; name the remote instead'],
];

function checkGitPush(rest) {
    const positionals = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) {
            i++;
            continue;
        }
        if (a === '--') {
            positionals.push(...rest.slice(i + 1));
            break;
        }
        if (a.startsWith('--') && a.length > 2) {
            const name = a.split('=')[0];
            const hit = name.length >= 3 ? PUSH_DANGER.find(([full]) => full.startsWith(name)) : undefined;
            if (hit) return block(`Blocked: \`git push ${a}\`: ${hit[1]}. Never force-push or rewrite main.`);
        } else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) {
            return block('Blocked: force push (-f). Never force-push; main in particular is never rewritten.');
        } else if (/^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) {
            return block('Blocked: `git push -d` deletes remote refs.');
        } else if (!a.startsWith('-')) positionals.push(a);
    }
    const [remote, ...refspecs] = positionals;
    if (remote === undefined || !refspecs.length) {
        return block(
            'Blocked: `git push` without an explicit remote and branch pushes whatever is configured, which can be main. ' +
                'Name both: `git push -u origin <branch>`.'
        );
    }
    for (const r of refspecs) {
        if (r.startsWith('+')) return block('Blocked: force push via a "+" refspec.');
        if (r.startsWith(':')) return block(`Blocked: \`git push ${remote} ${r}\` deletes a remote ref.`);
        if (!r.includes(':') && (r === 'HEAD' || r === '@')) {
            return block('Blocked: `git push <remote> HEAD` pushes the current branch, which may be main. Name the branch.');
        }
        const dst = (r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r).replace(/^refs\/heads\//, '');
        if (dst === 'main' || dst.includes('*')) {
            return block(
                `Blocked: \`git push ${remote} ${r}\` updates main directly. main is live on every enrolled machine; ` +
                    'push a branch and open a pull request (`gh pr create -R Danathar/appbox`).'
            );
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// node --test
// ---------------------------------------------------------------------------

// `node --test` is pre-approved in .claude/settings.json, but node options load
// and run code or write files. In test mode only these test-runner options are
// allowed. Value: false = flag, null = any value, RegExp = the value must match.
const NODE_TEST_OPTIONS = {
    '--test': false,
    '--test-only': false,
    '--watch': false,
    '--test-force-exit': false,
    '--experimental-test-coverage': false,
    '--no-warnings': false,
    '--enable-source-maps': false,
    '--test-name-pattern': null,
    '--test-skip-pattern': null,
    '--test-coverage-include': null,
    '--test-coverage-exclude': null,
    '--test-concurrency': /^\d+$/,
    '--test-timeout': /^\d+$/,
    '--test-shard': /^\d+\/\d+$/,
    '--test-isolation': /^(process|none)$/,
    '--experimental-test-isolation': /^(process|none)$/,
    '--test-coverage-lines': /^\d+(\.\d+)?$/,
    '--test-coverage-branches': /^\d+(\.\d+)?$/,
    '--test-coverage-functions': /^\d+(\.\d+)?$/,
    '--test-reporter': /^(spec|tap|dot|junit|lcov)$/,
    '--test-reporter-destination': /^(stdout|stderr)$/,
};

function checkNode(cmd, args, env) {
    const envKey = Object.keys(env).find((k) => /^NODE_/.test(k) && !SAFE_ENV.has(k));
    if (envKey) return block(`Blocked: \`${cmd}\` with ${envKey} set; NODE_OPTIONS and other NODE_* variables can load code or write files.`);
    if (!args.includes('--test')) return null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-') || a === '-' || a === '--') continue;
        const eq = a.indexOf('=');
        const name = eq === -1 ? a : a.slice(0, eq);
        const rule = Object.hasOwn(NODE_TEST_OPTIONS, name) ? NODE_TEST_OPTIONS[name] : undefined;
        let ok = rule !== undefined;
        if (ok && rule === false) ok = eq === -1;
        else if (ok) {
            const value = eq === -1 ? args[++i] : a.slice(eq + 1);
            ok = value !== undefined && (rule === null || rule.test(value));
        }
        if (!ok) {
            return block(
                `Blocked: \`${cmd} --test ... ${a}\`; only test-runner options are allowed under the pre-approved ` +
                    '`node --test` rule. Other node options can run code (--import, --require, --loader) or write files.'
            );
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Boxes, containers and images
// ---------------------------------------------------------------------------

const BOX = 'apps';
const PRIVILEGE = new Set(['sudo', 'doas', 'pkexec', 'run0', 'su', 'runuser']);
const DISTROBOX_NAMES = new Set([
    'distrobox', 'distrobox-enter', 'distrobox-rm', 'distrobox-stop', 'distrobox-upgrade', 'distrobox-assemble',
    'distrobox-create', 'distrobox-host-exec', 'distrobox-ephemeral', 'distrobox-list', 'distrobox-export',
]);
const ENGINES = new Set(['podman', 'docker', 'nerdctl', 'buildah']);
const APT = new Set(['apt', 'apt-get', 'apt-mark', 'dpkg']);
const KILLERS = new Set(['pkill', 'killall']);
// `kill` takes pids, not names; the pids may come from a lookup by app name (see checkPidKill).
const PID_KILLERS = new Set(['kill']);
const REMOVERS_LIST = ['rm', 'rmdir', 'shred', 'unlink', 'mv', 'truncate'];
// Words a wrapper or an unlisted program can hide; they are checked wherever they appear as a command.
const LOOKTHROUGH = new Set([
    'git', 'node', 'nodejs', ...SHELLS, 'eval', 'source', 'bats', 'systemctl', 'systemd-run', 'flatpak-spawn', 'toolbox',
    'rpm-ostree', 'bootc', ...PRIVILEGE, ...DISTROBOX_NAMES, ...ENGINES, ...APT, ...KILLERS, ...REMOVERS_LIST,
]);

const isBoxName = (a) => a === BOX || a === `${BOX}:latest`;
const isAppboxImage = (a) => /(^|\/)danathar\/appbox(:|@|$)/i.test(a) || /^appbox(:|@|$)/.test(a);
// A target the hook cannot see: built by a substitution, or filled in by xargs (`{}` or appended words).
const isBuilt = (a) => /[$`]/.test(a) || a === '{}';

/** `distrobox SUB ...` or `distrobox-SUB ...`. */
function checkDistrobox(cmd, args, state) {
    let sub;
    let rest;
    if (cmd === 'distrobox') {
        const at = args.findIndex((a) => !a.startsWith('-'));
        if (at === -1) return null;
        sub = args[at];
        rest = args.slice(at + 1);
    } else {
        sub = cmd.slice('distrobox-'.length);
        rest = args;
    }
    // install.md step 5 stops the old box (never removes it) before copying app data.
    if (sub === 'stop' && ownerSession()) return null;
    if (sub === 'rm' || sub === 'stop' || sub === 'upgrade') {
        const what = { rm: 'deletes the box (and every launcher whose name starts with its name)', stop: 'stops every app running in the box', upgrade: 'upgrades packages inside boxes, including apps that are open' }[sub];
        return block(`Blocked: \`distrobox ${sub}\` ${what}. Boxes on this machine are the user's; ask the owner.${sub === 'stop' ? OWNER_HINT : ''}`);
    }
    if (sub === 'assemble') {
        const action = rest.find((a) => !a.startsWith('-'));
        const dry = rest.some((a) => a === '--dry-run' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a));
        if ((action === 'rm' || (action === 'create' && !dry)) && !ownerSession()) {
            return block(
                `Blocked: \`distrobox assemble ${action}\` deletes or recreates boxes: distrobox.ini sets replace=true, so ` +
                    'creating from it removes the existing `apps` box first. Use --dry-run to see what it would do; the ' +
                    `owner recreates boxes (after checking that Signal and Claude are closed).${OWNER_HINT}`
            );
        }
        return null;
    }
    if (sub === 'enter') return checkBoxCommand('distrobox enter', rest, state, ['-n', '--name', '-a', '--additional-flags'], ['--', '-e', '--exec']);
    if (sub === 'host-exec') {
        const at = rest.findIndex((a) => !a.startsWith('-'));
        if (at === -1) return block('Blocked: `distrobox-host-exec` with no command starts a shell on the host; name the command to run.');
        return checkSegment(rest.slice(at), Object.create(state));
    }
    return null;
}

/**
 * A command run inside a box (`distrobox enter BOX -- CMD`, `toolbox run CMD`):
 * the words after one of `markers` (or, with no marker, after the box name when
 * `bareCommand`) are checked like a command of their own. No command at all is
 * an interactive shell that nobody sees, and is refused.
 */
function checkBoxCommand(what, rest, state, valueOpts, markers, bareCommand = false) {
    let inner = null;
    let positional = 0;
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (markers.includes(a)) {
            inner = rest.slice(i + 1);
            break;
        }
        if (valueOpts.includes(a)) {
            i++;
            continue;
        }
        if (a.startsWith('-')) continue;
        positional++;
        if (bareCommand || positional > 1) {
            inner = rest.slice(i);
            break;
        }
    }
    if (!inner || !inner.length) {
        return block(`Blocked: \`${what}\` with no command opens an interactive shell; name the command (\`${what} ${BOX} -- CMD\`).`);
    }
    return checkSegment(inner, Object.create(state));
}

function checkToolbox(args, state) {
    const at = args.findIndex((a) => !a.startsWith('-'));
    const sub = at === -1 ? undefined : args[at];
    if (sub === 'rm' || sub === 'rmi') return block(`Blocked: \`toolbox ${sub}\` deletes the user's containers or images.`);
    if (sub === 'run') return checkBoxCommand('toolbox run', args.slice(at + 1), state, ['-c', '--container', '-d', '--distro', '-r', '--release'], ['--'], true);
    if (sub === 'enter') return block('Blocked: `toolbox enter` opens an interactive shell; use `toolbox run CMD`.');
    return null;
}

// Engine global options that take a value, so the subcommand is found after them.
const ENGINE_VALUE_OPTS = ['--root', '--runroot', '--storage-driver', '--url', '--connection', '-c', '--log-level', '--cgroup-manager', '--tmpdir', '--context', '-H', '--host', '--config'];
const ENGINE_GROUPS = new Set(['container', 'image', 'system', 'volume', 'pod', 'network', 'builder', 'manifest']);

function checkEngine(cmd, args, state) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ENGINE_VALUE_OPTS.includes(args[i]) ? 2 : 1;
    let group = null;
    let sub = args[i];
    let rest = args.slice(i + 1);
    if (ENGINE_GROUPS.has(sub)) {
        group = sub;
        const at = rest.findIndex((a) => !a.startsWith('-'));
        sub = at === -1 ? undefined : rest[at];
        rest = at === -1 ? [] : rest.slice(at + 1);
    }
    const full = `${cmd} ${group ? `${group} ` : ''}${sub ?? ''}`.trim();
    if (sub === 'prune' || (group === 'system' && ['reset', 'migrate', 'renumber'].includes(sub))) {
        return block(`Blocked: \`${full}\` removes or rewrites the user's containers, images or volumes. Clean up only what your task created, by exact name.`);
    }
    const all = rest.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a));
    const positionals = rest.filter((a) => !a.startsWith('-'));
    const removesImages = sub === 'rmi' || (group === 'image' && sub === 'rm') || sub === 'untag';
    const removesContainers =
        (group === null || group === 'container') && ['rm', 'stop', 'kill', 'restart', 'pause'].includes(sub);
    if (group === 'volume' && sub === 'rm' && all) return block(`Blocked: \`${full} --all\` removes every volume.`);
    if (removesImages || removesContainers) {
        if (all) return block(`Blocked: \`${full} --all\` acts on every container or image the user has. Name the ones your task created.`);
        const built = positionals.find(isBuilt);
        if (built !== undefined) return block(`Blocked: \`${full} ${built}\` names its targets through a substitution; name them literally.`);
        const target = positionals.find((a) => (removesImages ? isAppboxImage(a) : isBoxName(a) || isAppboxImage(a)));
        if (target !== undefined) {
            return block(
                `Blocked: \`${full} ${target}\` acts on the user's real ${removesImages ? 'appbox image' : '`apps` box'}. ` +
                    'Rebuilds belong to host/appbox-update on the owner\'s machines; a local test image is tagged localhost/appbox:test.'
            );
        }
        return null;
    }
    if ((sub === 'run' || sub === 'create') && rest.includes('--replace')) {
        const named = rest.some((a, k) => isBoxName(a) && (rest[k - 1] === '--name' || a === `--name=${BOX}`)) || rest.includes(`--name=${BOX}`);
        if (named) return block(`Blocked: \`${full} --replace --name ${BOX}\` deletes the user's \`apps\` box.`);
    }
    if (sub === 'exec') {
        const valueOpts = ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys', '--preserve-fds'];
        let k = 0;
        while (k < rest.length && rest[k].startsWith('-')) k += valueOpts.includes(rest[k]) ? 2 : 1;
        if (isBoxName(rest[k] ?? '') && rest.length > k + 1) return checkSegment(rest.slice(k + 1), Object.create(state));
    }
    return null;
}

// ---------------------------------------------------------------------------
// Host changes
// ---------------------------------------------------------------------------

const SYSTEMCTL_CHANGING = [
    'start', 'stop', 'restart', 'try-restart', 'reload', 'reload-or-restart', 'try-reload-or-restart', 'enable',
    'disable', 'reenable', 'link', 'edit', 'mask', 'unmask', 'preset', 'revert', 'kill', 'isolate', 'set-property',
    'freeze', 'thaw', 'add-wants', 'add-requires',
];

function checkSystemctl(args) {
    if (ownerSession() && args.includes('--user')) return null;
    const { sub } = firstWord(args, ['-H', '--host', '-M', '--machine', '-p', '--property', '-t', '--type', '-s', '--signal', '-n', '--lines', '-o', '--output', '--state', '--root']);
    if (sub !== undefined && SYSTEMCTL_CHANGING.includes(sub) && args.some((a) => /appbox/i.test(a))) {
        return block(
            `Blocked: \`systemctl ${sub}\` of an appbox unit changes when (or whether) host/appbox-update runs on this ` +
                `machine, or runs it now. Only the owner does that.${OWNER_HINT}`
        );
    }
    if ((sub === 'daemon-reload' || sub === 'daemon-reexec') && args.includes('--user')) {
        return block(
            'Blocked: `systemctl --user daemon-reload` loads the unit files the checkout currently holds, including unmerged ' +
                `edits to host/*.service or host/*.timer. The owner runs it on each machine after a unit change is merged.${OWNER_HINT}`
        );
    }
    return null;
}

function checkImageTool(cmd, args) {
    const { sub } = firstWord(args, ['--sysroot']);
    const readOnly = { 'rpm-ostree': ['status', 'db', 'help'], bootc: ['status', 'help'] }[cmd];
    if (sub === undefined || readOnly.includes(sub)) return null;
    return block(`Blocked: \`${cmd} ${sub}\` changes the booted image or layers packages on the host. appbox never layers packages; only ${readOnly.join('/')} is allowed.`);
}

const APT_GET_READ = ['check', 'changelog', 'download', 'source', 'help', 'indextargets'];
const APT_READ = ['list', 'search', 'show', 'showsrc', 'depends', 'rdepends', 'policy', 'changelog', 'help', 'download'];
const APT_MARK_READ = ['showauto', 'showmanual', 'showhold', 'showinstall', 'showremove', 'showpurge', 'help'];

function checkApt(cmd, args) {
    if (cmd === 'dpkg') {
        const writes = args.find(
            (a) =>
                /^--(install|remove|purge|unpack|configure|triggers-only|set-selections|clear-selections|update-avail|merge-avail|force)/.test(a) ||
                /^-[a-zA-Z]*[irPaB][a-zA-Z]*$/.test(a)
        );
        return writes === undefined ? null : block(`Blocked: \`dpkg ${writes}\` changes installed packages. Queries (-l, -L, -s, -S) are fine.`);
    }
    const simulate = args.some((a) => ['-s', '--simulate', '--dry-run', '--just-print', '--no-act', '--recon'].includes(a));
    const { sub } = firstWord(args, ['-o', '--option', '-c', '--config-file', '-t', '--target-release']);
    const readOnly = { 'apt-get': APT_GET_READ, apt: APT_READ, 'apt-mark': APT_MARK_READ }[cmd];
    if (sub === undefined || readOnly.includes(sub) || (simulate && cmd !== 'apt-mark')) return null;
    return block(
        `Blocked: \`${cmd} ${sub}\` changes packages. Inside the \`apps\` box that touches Signal or Claude (only ` +
            'host/appbox-update upgrades them, and only while closed); on the host it is never done. Queries are fine.'
    );
}

// App data and machine state the user's apps and timer depend on.
const PROTECTED_PATHS = [
    [/(^|\/)\.config\/(Signal|Claude)(\/|$)/, "the user's live Signal or Claude data"],
    [/(^|\/)\.local\/state\/appbox(\/|$)/, "host/appbox-update's notification state"],
    [/(^|\/)\.local\/share\/applications\/apps/, 'the exported app launchers'],
    [/(^|\/)\.config\/systemd\/user(\/|$)/, 'the systemd user units (the appbox timer lives there)'],
    [/^~\/claude\/appbox\/?$|(^|\/)claude\/appbox\/?$/, 'the checkout the timer runs from'],
];
const REMOVERS = new Set(REMOVERS_LIST);

function checkRemover(cmd, args) {
    for (const a of args) {
        const hit = PROTECTED_PATHS.find(([re]) => re.test(a));
        if (hit) return block(`Blocked: \`${cmd} ${a}\` changes ${hit[1]}. Ask the owner.`);
    }
    return null;
}

function checkKiller(cmd, args) {
    const target = args.find((a) => /signal|claude/i.test(a));
    if (target === undefined) return null;
    return block(
        `Blocked: \`${cmd} ${target}\`: distrobox shares the host PID namespace, so this kills the user's open app. ` +
            'An open app is never touched. To fake a running app in a test, follow docs/working-on-the-repo.md (prctl).'
    );
}

// pgrep/pidof of Signal or Claude, as text: `$(pgrep -f signal-desktop)`, `pidof claude-desktop`.
const APP_PID_LOOKUP = /\b(pgrep|pidof)\b[^)`]*(signal|claude)/i;
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Does this word carry the pids of Signal or Claude: a lookup written in it, or a variable assigned from one? */
function wordHasAppPids(word, state) {
    if (APP_PID_LOOKUP.test(word)) return true;
    // The reader keeps only a `$()` marker for an unquoted substitution, so the command line's own lookups decide.
    if (state.appLookup && word.includes('$(')) return true;
    const vars = state.appPidVars;
    return vars !== undefined && [...word.matchAll(VAR_REF)].some((m) => vars.has(m[1]));
}

/** Is this pipe feeder a lookup of Signal's or Claude's pids, or does it print a variable holding them? */
function feedsAppPids(seg, state) {
    return seg.some((x, i) => ['pgrep', 'pidof'].includes(basename(x)) && seg.slice(i + 1).some((y) => /signal|claude/i.test(y))) ||
        seg.some((x) => wordHasAppPids(x, state));
}

/** The earlier stages of the pipe this segment reads from. */
function pipedWords(words) {
    const out = [];
    for (let p = words.pipedFrom; p; p = p.pipedFrom) out.push(p);
    return out;
}

/**
 * `kill` / `kill -9` of pids that come from pgrep/pidof of Signal or Claude: as
 * a substitution in its words, through a variable assigned from one, or piped
 * in (`pgrep signal-desktop | xargs kill`). `kill 1234` names no app and passes.
 */
function checkPidKill(cmd, args, words, xargsFed, state) {
    const fed = args.some((a) => wordHasAppPids(a, state)) || (xargsFed && pipedWords(words).some((f) => feedsAppPids(f, state)));
    if (!fed) return null;
    return block(
        `Blocked: \`${cmd}\` of pids found by name for Signal or Claude: distrobox shares the host PID namespace, so this kills the user's open app. ` +
            'An open app is never touched. To fake a running app in a test, follow docs/working-on-the-repo.md (prctl).'
    );
}

/** `xargs rm` and friends fed a protected path by an earlier pipe stage or here-string. */
function checkFedRemover(cmd, words) {
    const sources = [...pipedWords(words).flat(), ...(words.hereString === undefined ? [] : [words.hereString])];
    for (const src of sources) {
        for (const piece of src.split(/\s+/)) {
            const hit = PROTECTED_PATHS.find(([re]) => re.test(piece));
            if (hit) return block(`Blocked: \`${cmd}\` fed \`${piece}\` by xargs changes ${hit[1]}. Ask the owner.`);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Command names the shell builds, and programs this hook does not know
// ---------------------------------------------------------------------------

const CHECKED_NAMES = new Set([...LOOKTHROUGH, 'find', 'watch', 'flock', ...WRAPPERS]);
const { builtCommandName, namesCheckedCommand } = commandNameReader(CHECKED_NAMES);

// Programs that take file names only to read, list, copy or inspect them and
// never execute them. Behind these a machine script's path is data
// (`shellcheck host/appbox-update`, `wc -l host/install`); behind any other
// program it counts as the command that program runs. `gh` is here so a PR
// title or body may name the scripts; it still has its quoted text checked for
// other commands.
const FILE_OPERAND_PROGRAMS = new Set([
    'shellcheck', 'shfmt', 'checkbashisms', 'actionlint', 'wc', 'ls', 'stat', 'file', 'cp', 'mv', 'ln', 'chmod', 'chown',
    'touch', 'install', 'readlink', 'realpath', 'basename', 'dirname', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum',
    'b2sum', 'cksum', 'du', 'tree', 'test', '[', '[[', 'code', 'gh', 'git-blame', 'meld', 'patch', 'tar', 'zip',
]);

/**
 * For a segment whose command is a program this hook neither checks nor steps
 * over (`setarch x86_64 distrobox rm apps`, `script -qc '...'`), the refusal
 * for a checked command it would run, or null. Each later word naming a
 * checked command is checked from there to the end of the segment, and each
 * command string a word carries is checked as a command line of its own.
 */
function checkUnlistedProgram(w, inlineEnv, state) {
    const cmd = basename(w[0]);
    if (ARGUMENT_ONLY_PROGRAMS.has(w[0])) return null;
    // A machine script named behind this program is read as the command it runs
    // (`setarch x86_64 host/appbox-update`, `prlimit ... host/install`), unless
    // the program only reads or inspects files (FILE_OPERAND_PROGRAMS).
    const readsScripts = !FILE_OPERAND_PROGRAMS.has(cmd);
    // Only a path counts: a bare name (`journalctl -u appbox-update`) is a unit
    // or a word, and a program would look it up on PATH, where the scripts are not.
    const namesScript = (word) => readsScripts && word.includes('/') && ![null, 'unknown'].includes(machineScript(word));
    const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
    let checked = 0;
    for (let n = 1; n < w.length; n++) {
        spend();
        let refusal = null;
        if (namesCheckedCommand(w[n]) || namesCheckedCommand(unquoted(w[n])) || namesScript(w[n])) {
            if (++checked > MAX_UNLISTED_INNER) {
                return block(`Blocked: more than ${MAX_UNLISTED_INNER} commands this hook checks behind \`${cmd}\`, too many to read. Run them as commands of their own.`);
            }
            let start = n;
            while (start > 1 && isAssignment(w[start - 1])) start--;
            refusal = checkSegment([...env, ...w.slice(start)], Object.create(state));
        }
        if (!refusal) {
            for (const text of commandStrings(w[n])) {
                spend();
                const names = (t) => t.split(COMMAND_STRING_SEPARATORS).some((piece) => piece && (namesCheckedCommand(piece) || namesScript(piece)));
                const segments = tokenize(text);
                if (!names(text) && !names(unquoted(text)) && !segments.some((seg) => seg.length && builtCommandName(seg[0], true) !== null)) continue;
                refusal = checkCommand(text, Object.create(state));
                if (refusal) break;
            }
        }
        if (refusal) {
            return { ...refusal, reason: `\`${cmd}\` runs a command that is refused on its own, so it is checked as though it stood alone. ${refusal.reason}` };
        }
    }
    return null;
}

/** `find ... -exec|-execdir|-ok|-okdir CMD ARGS ;`: each such command is checked like a segment. */
function checkFindExec(args, state) {
    // `find PROTECTED -delete` and `find PROTECTED -exec rm ... {} +` remove what find walks, so the start paths count.
    const starts = [];
    for (const a of args) {
        if (a.startsWith('-') || a === '!' || a === '(') break;
        starts.push(a);
    }
    const hit = starts.map((a) => PROTECTED_PATHS.find(([re]) => re.test(a))).find(Boolean);
    if (hit) {
        const removes = args.includes('-delete') || args.some((a, i) => FIND_EXEC.includes(a) && REMOVERS.has(basename(args[i + 1] ?? '')));
        if (removes) return block(`Blocked: \`find\` deleting under ${hit[1]}. Ask the owner.`);
    }
    for (let i = 0; i < args.length; i++) {
        if (!FIND_EXEC.includes(args[i])) continue;
        let end = i + 1;
        while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++;
        if (args[i + 1] === '{}') {
            return block(`Blocked: \`find ... ${args[i]} {}\` runs every file find matches, which can be a machine script. Run the file you mean by name.`);
        }
        const r = checkSegment(args.slice(i + 1, end), Object.create(state));
        if (r) return r;
        i = end;
    }
    return null;
}

/** Shell options that take the next word as their value (`bash -o pipefail script`). */
const SHELL_VALUE_OPTS = ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'];

/**
 * A shell's own options and its first operand, read as the shell reads them:
 * options stop at the first word that is not one, or after `--` or `-`. Words
 * after the operand are the script's arguments (or, with -c, $0 and the
 * positional parameters), never the shell's options, so `bash host/install -n`
 * runs host/install with $1=-n.
 */
function shellInvocation(args) {
    const options = [];
    let at = -1;
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '--' || a === '-') {
            at = k + 1 < args.length ? k + 1 : -1;
            break;
        }
        if (SHELL_VALUE_OPTS.includes(a)) {
            options.push(a, args[k + 1] ?? '');
            k++;
        } else if (/^[-+]./.test(a)) {
            options.push(a);
        } else {
            at = k;
            break;
        }
    }
    return { options, at };
}

function checkShell(cmd, args, words, state) {
    const { pipedFrom, stdinFrom, hereString, heredocBody } = words;
    if (cmd === 'fish') {
        for (const script of fishScripts(args)) {
            const r = checkCommand(script, Object.create(state));
            if (r) return r;
        }
    }
    const { options, at } = shellInvocation(args);
    const syntaxOnly = options.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
    if (syntaxOnly) {
        // `bash -n` only parses, but a later +n or `+o noexec` turns that off again.
        const bad = options.find((a) => a.startsWith('+') || /[{}*?[$`]/.test(a));
        if (bad !== undefined) return block(`Blocked: \`${cmd} -n ... ${bad}\`; +n or +o noexec turns the syntax check off, so the script would run.`);
    }
    // With -c among the shell's own options, the operand is a command string.
    const commandMode = cmd !== 'fish' && options.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (commandMode) {
        if (at === -1) return null;
        const script = args[at];
        if (/^\$\([\s\S]*\)$|^`[\s\S]*`$/.test(script.trim()) && extractSubstitutions(script).some(readsScript)) {
            return block(`Blocked: \`${cmd} -c\` runs the text of a machine script. ${SCRIPT_WHY.updater}`);
        }
        return checkCommand(script, Object.create(state));
    }
    if (syntaxOnly) return null;
    if (cmd === 'fish' && fishScripts(args).length) return null;
    // The first operand is the script; the words after it are its arguments.
    if (at !== -1) {
        const kind = machineScript(args[at], true);
        return kind ? checkScriptRun(kind, args.slice(at + 1), `\`${cmd} ${args[at]}\``) : null;
    }
    // No operand: the shell runs what reaches its stdin.
    const feeders = [];
    for (let p = pipedFrom; p; p = p.pipedFrom) feeders.push(p);
    const reads =
        (hereString !== undefined && extractSubstitutions(hereString).some(readsScript)) ||
        (stdinFrom !== undefined && machineScript(stdinFrom, true)) ||
        feeders.some(segmentReadsScript);
    if (reads) return block(`Blocked: \`${cmd}\` reading a machine script on stdin runs it. ${SCRIPT_WHY.updater}`);
    const literal = (f) => {
        const name = basename(f[0] ?? '');
        if (name !== 'echo' && name !== 'printf') return undefined;
        const rest = f.slice(1).filter((a) => !a.startsWith('-'));
        if (name === 'printf') rest.shift();
        return rest.join(' ');
    };
    for (const text of [heredocBody, hereString, ...feeders.flatMap((f) => [f.heredocBody, f.hereString, literal(f)])]) {
        if (text === undefined) continue;
        const r = checkCommand(text, Object.create(state));
        if (r) return r;
    }
    return null;
}

/** The words bash's brace expansion makes of a command word, when they name a checked command (`{git,}`). */
function braceReading(word) {
    const built = builtCommandName(word, true);
    if (!built) return null;
    return built;
}

function checkSegment(words, state) {
    spend();
    const { stdinFrom } = words;
    let w = words.slice();
    const inlineEnv = {};
    let xargsFed = false;
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]) || w[0] === 'function' || w[0] === 'coproc')) {
            if (isAssignment(w[0])) {
                const eq = w[0].indexOf('=');
                inlineEnv[w[0].slice(0, eq)] = w[0].slice(eq + 1);
            }
            if (w[0] === 'function' || (w[0] === 'coproc' && w[2] === '{')) w.shift();
            w.shift();
        }
        if (!w.length) {
            // A bare assignment from a pgrep/pidof of the apps: a later `kill $VAR` kills them.
            for (const [name, value] of Object.entries(inlineEnv)) {
                if (wordHasAppPids(value, state)) (state.appPidVars ??= new Set()).add(name);
            }
            return null;
        }
        // A command name the shell builds with braces or wildcards: brace groups
        // that can build a checked command are refused, and a wildcard that can
        // match one is checked as each command it could match.
        const built = braceReading(w[0]);
        if (built?.braces) {
            return block(`Blocked: the shell reads the command name \`${w[0]}\` through brace groups that can build a command this hook checks. Spell the command name out.`);
        }
        if (built?.globs) {
            for (const name of built.globs) {
                const again = [...Object.entries(inlineEnv).map(([k, v]) => `${k}=${v}`), name, ...w.slice(1)];
                const { pipedFrom, stdinFrom: from, hereString, heredocBody } = words;
                const r = checkSegment(Object.assign(again, { pipedFrom, stdinFrom: from, hereString, heredocBody }), state);
                if (r) return { ...r, reason: `The shell can read the command name \`${w[0]}\` as \`${name}\`. ${r.reason}` };
            }
        }
        const cmd = basename(w[0]);
        if (PRIVILEGE.has(cmd)) return block(`Blocked: \`${cmd}\` (privilege escalation) is never run by agents in this repository.`);
        if (!WRAPPERS.has(cmd)) break;
        w = expandWrapperOptions(cmd, w);
        if (cmd === 'env') {
            for (let k = 1; k < w.length; k++) {
                const a = w[k];
                if (isAssignment(a)) continue;
                if (!a.startsWith('-')) break;
                if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(a)) {
                    k++;
                    continue;
                }
                let script = null;
                let rest = k + 1;
                if (a === '-S' || a === '--split-string') {
                    script = w[k + 1] ?? '';
                    rest = k + 2;
                } else if (a.startsWith('--split-string=')) script = a.slice(15);
                else if (/^-S./.test(a)) script = a.slice(2);
                if (script === null) continue;
                const alone = checkCommand(script, state);
                if (alone) return alone;
                return checkSegment([...tokenize(script).flat(), ...w.slice(rest)], state);
            }
        }
        const idx = wrapperTarget(w);
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) {
            if (isAssignment(x)) {
                const eq = x.indexOf('=');
                inlineEnv[x.slice(0, eq)] = x.slice(eq + 1);
            }
        }
        if (idx === -1) return null;
        if (cmd === 'watch') {
            const r = checkCommand(w.slice(idx).join(' '), Object.create(state));
            if (r) return r;
        } else if (cmd === 'flock' && (w[idx] === '-c' || w[idx] === '--command')) {
            return checkCommand(w[idx + 1] ?? '', Object.create(state));
        }
        if (cmd === 'xargs') xargsFed = true;
        w = w.slice(idx);
    }

    const cmd = basename(w[0]);
    const args = w.slice(1);
    if (xargsFed && (cmd === 'git' || cmd === 'node' || cmd === 'nodejs' || SHELLS.has(cmd))) {
        return block(`Blocked: \`xargs ${cmd}\`; xargs adds arguments read at run time, so this hook cannot check the ${cmd} command line. Write it out in full.`);
    }
    if (xargsFed && REMOVERS.has(cmd)) {
        const r = checkFedRemover(cmd, words);
        if (r) return r;
    }
    if (cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && args.some((a) => /^-[a-zA-Z]*x/.test(a)))) {
        for (const a of args) {
            const eq = a.indexOf('=');
            const name = eq === -1 ? a : a.slice(0, eq);
            if (/^(GIT_|NODE_|PAGER$|EDITOR$|VISUAL$)/.test(name)) (state.exportedEnv ??= {})[name] = eq === -1 ? null : a.slice(eq + 1);
        }
        return null;
    }

    // The repository's machine scripts, run directly.
    const kind = machineScript(w[0]);
    if (kind && (kind !== 'unknown' || w[0].includes('/') || /^[$`]/.test(w[0]))) {
        return checkScriptRun(kind, args, `running ${w[0]}`);
    }
    if (cmd === 'source' || cmd === '.') {
        const hit = scriptOperand(args.slice(0, 1));
        return hit ? checkScriptRun(hit.kind, [], `sourcing ${args[0]}`, true) : null;
    }
    if (cmd === 'bats') {
        const hit = args.find((a) => {
            const eq = a.indexOf('=');
            return machineScript(a, true) || (eq !== -1 && machineScript(a.slice(eq + 1), true));
        });
        return hit === undefined ? null : block(`Blocked: \`bats ${hit}\` sources the file to collect tests, which runs it. ${SCRIPT_WHY[machineScript(hit.split('=').pop(), true) ?? 'updater']}`);
    }

    if (READERS.has(cmd)) {
        const r = checkReader(cmd, args, stdinFrom);
        if (r) return r;
    }
    if (cmd === 'git') return checkGit(args, inlineEnv, state.exportedEnv ?? {});
    if (cmd === 'node' || cmd === 'nodejs') return checkNode(cmd, args, { ...(state.exportedEnv ?? {}), ...inlineEnv });
    if (SHELLS.has(cmd)) return checkShell(cmd, args, words, state);
    if (cmd === 'eval') return checkCommand(args.join(' '), Object.create(state));
    if (DISTROBOX_NAMES.has(cmd)) return checkDistrobox(cmd, args, state);
    if (cmd === 'toolbox') return checkToolbox(args, state);
    // xargs appends the targets at run time (`podman ps -aq | xargs podman rm`); stand one in that the hook cannot see.
    if (ENGINES.has(cmd)) return checkEngine(cmd, xargsFed ? [...args, '$(xargs)'] : args, state);
    if (cmd === 'systemctl') return checkSystemctl(args);
    if (cmd === 'rpm-ostree' || cmd === 'bootc') return checkImageTool(cmd, args);
    if (APT.has(cmd)) return checkApt(cmd, args);
    if (KILLERS.has(cmd)) return checkKiller(cmd, args);
    if (PID_KILLERS.has(cmd)) return checkPidKill(cmd, args, words, xargsFed, state);
    if (REMOVERS.has(cmd)) return checkRemover(cmd, args);
    if (cmd === 'find') return checkFindExec(args, state);
    if (cmd === 'systemd-run' || cmd === 'flatpak-spawn') {
        // Look through to the command they run, wherever it starts.
        const at = args.findIndex((a) => machineScript(a) || LOOKTHROUGH.has(basename(a)) || READERS.has(basename(a)));
        return at === -1 ? null : checkSegment(args.slice(at), Object.create(state));
    }
    if (READERS.has(cmd)) return null;
    return checkUnlistedProgram(w, inlineEnv, state);
}

/** Analyse a command line. Returns null if allowed, else { blocked, reason }. */
export function checkCommand(command, outer = {}) {
    const subs = extractSubstitutions(command);
    // Whether this command line looks up the pids of Signal or Claude in a substitution (see wordHasAppPids).
    const state = Object.create(outer);
    state.appLookup = subs.some((sub) => APP_PID_LOOKUP.test(sub));
    for (const sub of subs) {
        const r = checkCommand(sub, state);
        if (r) return r;
    }
    for (const words of tokenize(command)) {
        const r = checkSegment(words, state);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(check = checkCommand, budgetMs = BUDGET_MS) {
    // Claude Code blocks only on exit 2; any other failure (an uncaught
    // exception exits 1) lets the command run. So nothing may escape this function.
    try {
        let payload;
        try {
            payload = JSON.parse(readFileSync(0, 'utf8'));
        } catch {
            process.stderr.write('guard-bash: could not parse hook input as JSON; blocking (fail closed).\n');
            process.exit(2);
        }
        if (payload?.tool_name && payload.tool_name !== 'Bash') process.exit(0);
        const command = payload?.tool_input?.command;
        if (typeof command !== 'string' || !command.trim()) process.exit(0);
        startBudget(budgetMs);
        const result = check(command);
        if (result) {
            process.stderr.write(`guard-bash: ${result.reason}\n`);
            process.exit(2);
        }
    } catch (err) {
        if (err instanceof OverBudget) {
            process.stderr.write(`guard-bash: ${err.message}\n${GUIDANCE}\n`);
            process.exit(2);
        }
        process.stderr.write(`guard-bash: internal error (${err?.message ?? err}); blocking (fail closed).\n`);
        process.exit(2);
    }
    process.exit(0);
}

/** True when this file is the program being run (also through a symlink); never fails open. */
function isMain() {
    const arg = process.argv[1];
    if (!arg) return false;
    const self = fileURLToPath(import.meta.url);
    if (resolve(arg) === self) return true;
    try {
        return realpathSync(arg) === self;
    } catch {
        return basename(arg) === 'guard-bash.mjs';
    }
}

if (isMain()) main();
