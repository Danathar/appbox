// The `env` block in .claude/settings.json sets git's safe.bareRepository to
// `explicit` for every command an agent runs. Without it, a bare repository
// committed as ordinary files in a checked-out branch is picked up by
// pre-approved git commands (`git show` or `git log -p`, run with that folder
// as the working directory), and its config can name a program for git to run
// (diff.*.textconv, core.pager, core.fsmonitor, ...) with no permission prompt.
// The guard hook cannot see that config, so git itself has to refuse the
// repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url));
const settingsEnv = JSON.parse(readFileSync(SETTINGS, 'utf8')).env ?? {};

// A clean git environment: no user or system config, no inherited GIT_* overrides.
function baseEnv(home) {
    return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function git(cwd, env, ...args) {
    return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

// Builds a clone whose tree carries a committed bare repository `evil/` whose
// attributes route every file through a diff.x.textconv program that writes
// `marker`. Returns the clone's path.
function plantedClone(dir, marker) {
    const env = baseEnv(dir);
    const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    const work = join(dir, 'work');
    const src = join(dir, 'src');
    const evil = join(src, 'evil');
    assert.equal(git(dir, env, 'init', '-q', work).status, 0);
    writeFileSync(join(work, 'f.txt'), 'hello\n');
    assert.equal(git(work, env, 'add', 'f.txt').status, 0);
    assert.equal(git(work, env, ...ident, 'commit', '-qm', 'inner').status, 0);
    assert.equal(git(dir, env, 'init', '-q', src).status, 0);
    assert.equal(git(dir, env, 'clone', '-q', '--bare', work, evil).status, 0);
    mkdirSync(join(evil, 'refs', 'heads'), { recursive: true });
    mkdirSync(join(evil, 'info'), { recursive: true });
    writeFileSync(join(evil, 'refs', 'heads', '.keep'), '');
    writeFileSync(join(evil, 'objects', '.keep'), '');
    writeFileSync(join(evil, 'info', 'attributes'), '* diff=x\n');
    assert.equal(git(evil, env, 'config', 'diff.x.textconv', `touch '${marker}'; cat`).status, 0);
    assert.equal(git(src, env, 'add', 'evil').status, 0);
    assert.equal(git(src, env, ...ident, 'commit', '-qm', 'x').status, 0);
    assert.equal(git(dir, env, 'clone', '-q', src, 'victim').status, 0);
    return join(dir, 'victim');
}

test('settings.json sets safe.bareRepository=explicit through GIT_CONFIG_* for agent commands', () => {
    assert.deepEqual(settingsEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.bareRepository',
        GIT_CONFIG_VALUE_0: 'explicit',
    });
});

test('a committed bare repository cannot make a pre-approved git show or git log -p run a program', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };

    const cases = [
        [victim, ['-C', 'evil', 'show']],
        [victim, ['-C', 'evil', 'log', '-p', '-1']],
        [join(victim, 'evil'), ['show']],
        [join(victim, 'evil'), ['log', '-p', '-1']],
    ];

    // The planted program does run without the setting, so the check below is real.
    for (const [cwd, args] of cases) {
        git(cwd, baseEnv(dir), ...args);
        assert.ok(existsSync(marker), `precondition: without safe.bareRepository, git ${args.join(' ')} runs the planted textconv`);
        rmSync(marker);
    }

    for (const [cwd, args] of cases) {
        const r = git(cwd, agentEnv, ...args);
        assert.notEqual(r.status, 0, `git ${args.join(' ')} should refuse the bare repository`);
        assert.match(r.stderr, /safe\.bareRepository/);
        assert.ok(!existsSync(marker), `git ${args.join(' ')} ran the planted program`);
    }

    // The checkout's own repository (.git/, not bare) still works with the setting.
    assert.equal(git(victim, agentEnv, 'status', '--short').status, 0);
    assert.equal(git(victim, agentEnv, 'log', '-1', '--format=%s').stdout.trim(), 'x');
    assert.equal(git(victim, agentEnv, 'show', '--format=%s', '-s').stdout.trim(), 'x');
});
