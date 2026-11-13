// Tests for .claude/hooks/guard-bash.mjs, the PreToolUse Bash guard.
//
// Most cases call checkCommand() directly, which is the whole decision. A few
// spawn the hook exactly as Claude Code does (JSON on stdin, exit 0 to allow,
// exit 2 to block with the reason on stderr) to pin the protocol, including
// failing closed on input it cannot read.
//
// Run: node --test .claude/hooks/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCommand, isSecretPath, machineScript, OWNER_ENV } from '../guard-bash.mjs';

const HOOK = fileURLToPath(new URL('../guard-bash.mjs', import.meta.url));

// The owner switch is read from this process's environment. These tests may
// themselves run inside an owner session, so start from a clean environment
// and turn the switch on only where a test says so.
delete process.env[OWNER_ENV];
const BASE_ENV = { ...process.env };

function runHook(input, extraEnv = {}) {
    return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 20000, env: { ...BASE_ENV, ...extraEnv } });
}

/** Run fn with the owner switch on in this process, then turn it off again. */
function asOwner(fn) {
    process.env[OWNER_ENV] = '1';
    try {
        return fn();
    } finally {
        delete process.env[OWNER_ENV];
    }
}

// Commands an agent runs in ordinary work on this repository. None may be refused.
const allowed = [
    // checks and reading
    'node --test scripts/tests .claude/hooks/tests',
    'node --test .claude/hooks/tests/',
    'bats tests/unit',
    'bats tests/unit tests/e2e',
    'shellcheck host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync',
    'podman run --rm -v "$PWD:/mnt:ro,z" -w /mnt docker.io/koalaman/shellcheck:stable host/appbox-update host/install scripts/*',
    'bash -n host/appbox-update',
    'sh -n scripts/claude-desktop-sync',
    'cat host/appbox-update',
    'sed -n 180,220p host/appbox-update',
    'grep -n rebuild_skipped host/appbox-update',
    'grep -rn cosign.key docs README.md',
    'less distrobox.ini',
    'cat hosts/example.env hosts/aurora-think.env',
    'cat cosign.pub keys/ublue-os-toolboxes.pub',
    'cat ~/.ssh/id_ed25519.pub',
    'jq . .claude/settings.json',
    'actionlint',
    'actionlint -color',
    'actionlint -shellcheck= .github/workflows/ci.yml',
    'actionlint -pyflakes=',
    '[ -f host/appbox-update ] && echo present',
    'ls -l cosign.key',
    'test -f ~/.config/appbox-signing/cosign.key && wc -c ~/.config/appbox-signing/cosign.key',
    'cosign public-key --key cosign.key',
    'gh secret set SIGNING_SECRET -R Danathar/appbox < cosign.key',
    'cp cosign.key /var/tmp/backup/cosign.key',
    // the one allowed run of the update script
    'host/appbox-update --show-config',
    './host/appbox-update --show-config',
    '~/claude/appbox/host/appbox-update --show-config',
    'APPBOX_SELF_UPDATE=0 host/appbox-update --show-config',
    'bash host/appbox-update --show-config',
    'host/appbox-update --show-config | grep image',
    // coreutils install is not host/install
    'install -m 600 cosign.key /var/tmp/k/cosign.key',
    '/usr/bin/install -d /var/tmp/x',
    // git
    'git status',
    'git log --oneline -20',
    'git diff origin/main...HEAD',
    'git show HEAD:host/appbox-update',
    'git push -u origin acmm/agent-config',
    'git push origin feature-branch',
    'git push origin HEAD:refs/heads/fix-notify',
    'git push --set-upstream origin fix/x',
    'git push origin v1.2.3',
    'git push --tags origin fix/x',
    'git commit -s -m "Fix the notify path"',
    'git reset --soft HEAD~1',
    'git reset HEAD file.txt',
    'git config --get remote.origin.url',
    'git fetch origin',
    'git pull --rebase',
    // boxes and containers, read-only or throwaway
    'distrobox list',
    'distrobox enter apps -- dpkg -L signal-desktop',
    "distrobox enter apps -- sh -c 'dpkg -L claude-desktop | grep desktop'",
    'distrobox enter apps -- apt-cache madison claude-desktop',
    'distrobox enter apps -- apt list --installed',
    'distrobox assemble create --dry-run --file distrobox.ini',
    'distrobox create --name scratch-test --image ubuntu:24.04',
    'podman ps -a',
    'podman inspect -f "{{.State.Pid}}" apps',
    'podman images',
    'podman build -f ContainerFiles/appbox -t localhost/appbox:test .',
    'podman rmi localhost/appbox:test',
    'podman rm -f appbox-e2e-1234',
    'podman run --rm ghcr.io/danathar/appbox:latest signal-desktop --version',
    "podman exec -d apps python3 -c 'import ctypes,time; ctypes.CDLL(None).prctl(15, b\"signal-desktop\", 0, 0, 0); time.sleep(120)'",
    'pgrep -ax "claude-desktop|signal-desktop"',
    'pkill -f my-test-sleeper',
    // finding and killing things that are not the apps or their data
    'find ~/projects -delete',
    'find ~/projects -name "*.tmp" -exec rm {} +',
    'find ~/.config/Signal -name "*.log"',
    'find ~/.config/Signal -type f | wc -l',
    'ls ~/.config/Signal | xargs echo',
    'echo /tmp/scratch | xargs rm -rf',
    'kill 1234',
    'kill -9 1234',
    'pgrep signal-desktop',
    'pidof claude-desktop',
    'pids=$(pgrep my-test-sleeper); kill $pids',
    'pgrep my-test-sleeper | xargs kill',
    'distrobox enter apps -- pgrep signal-desktop',
    // systemd, read-only
    'systemctl --user list-timers appbox-update.timer',
    'systemctl --user status appbox-update.service',
    'journalctl --user -u appbox-update -n 50',
    'rpm-ostree status --booted',
    // quoted text is data
    'echo "never run distrobox rm apps"',
    "printf '%s\\n' 'git push --force'",
    'grep -n "git push --force" AGENTS.md',
    'gh pr create -R Danathar/appbox --base main --head acmm/agent-config --title "Agent config" --body-file /var/tmp/body.md',
    'gh pr view 70 -R Danathar/appbox',
    'timeout 60 node --test .claude/hooks/tests',
    'setarch x86_64 host/appbox-update --show-config',
    "script -qc 'host/appbox-update --show-config' /dev/null",
    'wc -l host/install host/appbox-update',
    'cp host/appbox-update /var/tmp/scratch/appbox-update',
    'sha256sum host/appbox-update',
    'gh pr create -R Danathar/appbox --title "host/appbox-update: notify on failure" --body-file /var/tmp/b.md',
    'bash -n host/install',
    'bash -nx host/appbox-update',
    'sh -n -- host/install',
    'bash -c "echo hi" host/install',
    'python3 tools/x.py "$FILE"',
    'rm -rf /var/tmp/ab-c',
    'rm -rf ~/claude/appbox/scratch',
    'ls ~/.config/Signal',
    'du -sh ~/.config/Signal',
    'rsync -aHAX ~/ubuntu-signal/.config/Signal ~/.config/',
    'ssh-keygen -y -f ~/.ssh/id_ed25519',
    'git commit -s -m "Block distrobox rm apps and podman rm apps"',
    'podman ps -aq --filter name=appbox-e2e | xargs -r podman inspect',
];

// Commands the guard must refuse, each with a fragment of the reason.
const blocked = [
    // the update script and the other machine scripts
    ['host/appbox-update', /appbox-update/],
    ['./host/appbox-update', /appbox-update/],
    ['host/appbox-update --force', /appbox-update/],
    ['host/appbox-update --help', /appbox-update/],
    ['host/appbox-update --force --show-config', /appbox-update/],
    ['/var/home/u/claude/appbox/host/appbox-update', /appbox-update/],
    ['~/claude/appbox/host/appbox-update', /appbox-update/],
    ['"$CLAUDE_PROJECT_DIR"/host/appbox-update', /appbox-update/],
    ["printf '[apps]\\nimage=ghcr.io/danathar/does-not-exist:latest\\n' > /tmp/t.ini && APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini host/appbox-update --force", /throwaway-ini/],
    ['APPBOX_SELF_UPDATE=0 APPBOX_INI=/var/tmp/t.ini host/appbox-update', /throwaway-ini/],
    ['env APPBOX_SELF_UPDATE=0 host/appbox-update', /appbox-update/],
    ['env -i PATH=/usr/bin host/appbox-update', /appbox-update/],
    ['timeout 600 host/appbox-update --force', /appbox-update/],
    ['nohup host/appbox-update &', /appbox-update/],
    ['exec host/appbox-update', /appbox-update/],
    ['sh host/appbox-update', /appbox-update/],
    ['bash host/appbox-update', /appbox-update/],
    ['bash -x host/appbox-update --force', /appbox-update/],
    ['bash -o pipefail host/appbox-update', /appbox-update/],
    ["bash -c 'host/appbox-update --force'", /appbox-update/],
    ["sh -c 'cd ~/claude/appbox && ./host/appbox-update'", /appbox-update/],
    ['bash -c "$(cat host/appbox-update)"', /machine script/],
    ['cat host/appbox-update | bash', /stdin/],
    ['bash < host/appbox-update', /stdin/],
    ['source host/appbox-update', /sourcing/],
    ['. host/appbox-update --show-config', /sourcing/],
    ['bats host/appbox-update', /bats/],
    // actionlint runs whatever -shellcheck/-pyflakes name, once per run: step
    ['actionlint -shellcheck=host/install', /actionlint -shellcheck/],
    ['actionlint -shellcheck host/appbox-update', /actionlint -shellcheck/],
    ['actionlint --shellcheck=./host/install .github/workflows/claude.yml', /actionlint -shellcheck/],
    ['actionlint -pyflakes=host/install', /actionlint -pyflakes/],
    ['actionlint -color -pyflakes python3', /actionlint -pyflakes/],
    ['timeout 60 actionlint -shellcheck=/tmp/x.sh', /actionlint -shellcheck/],
    // the actionlint check must not skip the checks that ran before it
    ['actionlint -color distrobox rm apps', /distrobox|apps/],
    ['eval host/appbox-update', /appbox-update/],
    ['systemd-run --user host/appbox-update', /appbox-update/],
    ['find host -name appbox-update -exec {} \\;', /appbox-update|\{\}/],
    ['find . -name x -exec host/appbox-update \\;', /appbox-update/],
    ['distrobox-host-exec host/appbox-update', /appbox-update/],
    ['distrobox enter apps -- ~/claude/appbox/host/appbox-update', /appbox-update/],
    ['host/appbox-up*', /appbox-update/],
    ['host/install', /host\/install/],
    // machine scripts behind programs this hook does not otherwise know (Codex review on #69)
    ['setarch x86_64 host/appbox-update --force', /appbox-update/],
    ['setarch x86_64 ~/claude/appbox/host/appbox-update', /appbox-update/],
    ['prlimit --nofile=1024 host/install', /host\/install/],
    ['strace -f -o /var/tmp/trace host/appbox-update', /appbox-update/],
    ['setsid -f host/install', /host\/install/],
    ['nice -n 19 host/appbox-update', /appbox-update/],
    ['ionice -c3 host/appbox-update --force', /appbox-update/],
    ['chrt -i 0 host/appbox-update', /appbox-update/],
    ['taskset 1 host/install', /host\/install/],
    ['stdbuf -oL host/appbox-update', /appbox-update/],
    ['unshare host/appbox-update', /appbox-update/],
    ["script -qc 'host/appbox-update --force' /dev/null", /appbox-update/],
    ["script -qc'host/install' /dev/null", /host\/install/],
    ['make check host/install', /host\/install/],
    // a shell's own options end at its first operand (Codex review on #69)
    ['bash host/install -n', /host\/install/],
    ['sh host/appbox-update -n', /appbox-update/],
    ['bash host/install -c true', /host\/install/],
    ['bash -x -- host/install', /host\/install/],
    ['bash -e host/appbox-update --force', /appbox-update/],
    ['bash -o pipefail host/install -n', /host\/install/],
    ['bash -n +n host/install', /\+n/],
    ['./host/install', /host\/install/],
    ['~/claude/appbox/host/install', /host\/install/],
    ['bash host/install', /host\/install/],
    ['cd host && ./install', /host\/install/],
    ['scripts/appbox.sh', /image build/],
    ['bash scripts/appbox.sh', /image build/],
    ['scripts/claude-desktop-sync', /init hook/],
    ['/usr/libexec/appbox/claude-desktop-sync', /init hook/],
    ['distrobox enter apps -- sudo /usr/libexec/appbox/claude-desktop-sync', /privilege|init hook/],
    // boxes
    ['distrobox rm apps', /distrobox rm/],
    ['distrobox rm --force apps', /distrobox rm/],
    ['distrobox-rm apps', /distrobox rm/],
    ['distrobox rm --force ubuntu-signal', /distrobox rm/],
    ['distrobox stop apps', /distrobox stop/],
    ['distrobox stop --yes apps', /distrobox stop/],
    ['distrobox upgrade --all', /distrobox upgrade/],
    ['distrobox assemble create --replace --file distrobox.ini', /assemble create/],
    ['distrobox assemble create --file ~/claude/appbox/distrobox.ini', /replace=true/],
    ['distrobox assemble rm --file distrobox.ini', /assemble rm/],
    ['distrobox-assemble create --file hosts/aurora-think.ini', /assemble create/],
    ['distrobox enter apps', /interactive/],
    ['distrobox enter apps -- sudo apt-get install -y --allow-downgrades claude-desktop=1.0', /privilege/],
    ['distrobox enter apps -- apt-get install -y claude-desktop', /apt-get install/],
    ['distrobox enter apps -- apt-mark hold signal-desktop', /apt-mark hold/],
    ['distrobox enter apps -- dpkg -r signal-desktop', /dpkg/],
    ["distrobox enter apps -- sh -c 'pkill signal-desktop'", /open app/],
    ['toolbox rm fedora-toolbox-42', /toolbox rm/],
    ['toolbox enter', /interactive/],
    ['setarch x86_64 distrobox rm apps', /distrobox rm/],
    ['timeout 30 distrobox stop apps', /distrobox stop/],
    // containers and images
    ['podman rm apps', /apps/],
    ['podman rm -f apps', /apps/],
    ['podman container rm --force apps', /apps/],
    ['podman stop apps', /apps/],
    ['podman kill apps', /apps/],
    ['podman restart apps', /apps/],
    ['podman rm -a', /--all/],
    ['podman rm -af', /--all/],
    ['podman rm $(podman ps -aq)', /substitution/],
    ['podman rmi ghcr.io/danathar/appbox:latest', /appbox image/],
    ['podman rmi ghcr.io/danathar/appbox:20261101', /appbox image/],
    ['podman image rm ghcr.io/danathar/appbox@sha256:abc', /appbox image/],
    ['podman rmi -a -f', /--all/],
    ['podman system prune -a', /prune/],
    ['podman image prune -a', /prune/],
    ['podman container prune', /prune/],
    ['podman volume prune', /prune/],
    ['podman system reset', /reset/],
    ['podman volume rm --all', /every volume/],
    ['podman run --replace --name apps ubuntu', /apps/],
    ['podman exec apps apt-get remove -y signal-desktop', /apt-get remove/],
    ['docker rm -f apps', /apps/],
    ['buildah rm --all', /--all/],
    ['podman ps -aq | xargs podman rm -f', /substitution/],
    ['echo x | xargs -I{} podman rm {}', /substitution/],
    ['rm -rf ~/.config/Signal', /Signal or Claude data/],
    ['xargs rm -rf ~/.config/Claude', /Signal or Claude data/],
    ['mv ~/.local/state/appbox /var/tmp/x', /notification state/],
    ['rm ~/.local/share/applications/apps-signal-desktop.desktop', /launchers/],
    ['rm -rf ~/claude/appbox', /checkout/],
    ['gh pr comment 1 -R Danathar/appbox --body "then run distrobox rm apps"', /distrobox rm/],
    ['buildah rmi --all', /--all/],
    ['pkill signal-desktop', /open app/],
    ['pkill -f claude-desktop', /open app/],
    ['killall signal-desktop', /open app/],
    // find and xargs reaching protected data; kill of pids looked up by app name
    ['find ~/.config/Signal -delete', /Signal or Claude data/],
    ['find ~/.config/Claude -type f -delete', /Signal or Claude data/],
    ['find ~/.config/Signal -name "*.db" -exec rm {} +', /Signal or Claude data/],
    ['find ~/.config/Signal -exec rm -rf {} \\;', /Signal or Claude data/],
    ['find ~/.local/state/appbox -delete', /notification state/],
    ['find ~/.config/Signal | xargs rm -rf', /Signal or Claude data/],
    ['find ~/.config/Signal -print0 | xargs -0 rm', /Signal or Claude data/],
    ['echo ~/.config/Claude | xargs rm -rf', /Signal or Claude data/],
    ['xargs rm -rf <<< ~/.config/Signal', /Signal or Claude data/],
    ['kill $(pgrep signal-desktop)', /open app/],
    ['kill -9 $(pgrep -f claude-desktop)', /open app/],
    ['kill -9 `pidof signal-desktop`', /open app/],
    ['kill -TERM "$(pidof claude-desktop)"', /open app/],
    ['pids=$(pgrep signal-desktop); kill $pids', /open app/],
    ['pid=$(pgrep -f claude-desktop) && kill -9 "$pid"', /open app/],
    ['pgrep signal-desktop | xargs kill', /open app/],
    ['pgrep -f claude-desktop | xargs kill -9', /open app/],
    ['pidof signal-desktop | xargs -r kill', /open app/],
    ['distrobox enter apps -- kill $(pgrep signal-desktop)', /open app/],
    ["distrobox enter apps -- sh -c 'kill -9 $(pidof claude-desktop)'", /open app/],
    ["distrobox enter apps -- sh -c 'pgrep -f signal-desktop | xargs kill'", /open app/],
    ["distrobox enter apps -- sh -c 'p=$(pgrep signal-desktop); kill -9 $p'", /open app/],
    // host changes
    ['systemctl --user start appbox-update', /appbox unit/],
    ['systemctl --user start appbox-update.service', /appbox unit/],
    ['systemctl --user stop appbox-update.timer', /appbox unit/],
    ['systemctl --user enable --now appbox-update.timer', /appbox unit/],
    ['systemctl --user disable appbox-update.timer', /appbox unit/],
    ['systemctl --user restart appbox-update.timer', /appbox unit/],
    ['systemctl --user mask appbox-update.timer', /appbox unit/],
    ['systemctl --user daemon-reload', /daemon-reload/],
    ['sudo rpm-ostree install htop', /privilege/],
    ['rpm-ostree install htop', /layers packages/],
    ['rpm-ostree override remove firefox', /layers packages/],
    ['bootc switch ghcr.io/x/y', /booted image/],
    ['sudo ls', /privilege/],
    ['pkexec ls', /privilege/],
    ['run0 ls', /privilege/],
    ['env FOO=1 sudo -E ls', /privilege/],
    ['apt-get update', /apt-get update/],
    ['apt install signal-desktop', /apt install/],
    ['dpkg -i claude-desktop.deb', /dpkg/],
    // secrets
    ['cat .env', /secret/],
    ['cat ./.env.local', /secret/],
    ['head -c 64 cosign.key', /secret/],
    ['tail ~/.config/appbox-signing/cosign.key', /secret/],
    ['cat ~/.ssh/id_ed25519', /secret/],
    ['cat ~/.ssh/config', /secret/],
    ['less ~/.config/gh/hosts.yml', /secret/],
    ['cat < cosign.key', /secret/],
    ['xxd cosign.key | head', /secret/],
    ['base64 -w0 cosign.key', /secret/],
    ['grep ENCRYPTED cosign.key', /secret/],
    ['grep -e foo .env', /secret/],
    ['sed -n 1p cosign.key', /secret/],
    ['dd if=cosign.key bs=1 count=10', /secret/],
    ['cat *.key', /secret/],
    ['cat ~/.docker/config.json', /secret/],
    ['timeout 5 cat .env', /secret/],
    ["bash -c 'cat cosign.key'", /secret/],
    ['git show HEAD:.env', /secret/],
    ['git diff /dev/null ./.env', /secret/],
    // git
    ['git push', /explicit remote/],
    ['git push origin', /explicit remote/],
    ['git push origin HEAD', /may be main/],
    ['git push origin main', /main directly/],
    ['git push -u origin main', /main directly/],
    ['git push origin HEAD:main', /main directly/],
    ['git push origin feature:refs/heads/main', /main directly/],
    ['git push origin refs/heads/*:refs/heads/*', /main directly/],
    ['git push --force origin fix/x', /force/],
    ['git push -f origin fix/x', /force/],
    ['git push -uf origin fix/x', /force/],
    ['git push --force-with-lease origin fix/x', /force/],
    ['git push --forc origin fix/x', /force/],
    ['git push origin +fix/x', /force/],
    ['git push --mirror origin', /mirror/],
    ['git push --all origin', /every local branch/],
    ['git push origin --delete fix/x', /delet/],
    ['git push origin :fix/x', /delet/],
    ['git push --repo=https://example.com/x.git fix/x', /redirect/],
    ['git -C /var/tmp/ab push origin main', /main directly/],
    ['git reset --hard origin/main', /reset --hard/],
    ['git reset --hard', /reset --hard/],
    ['git -C ~/claude/appbox fetch && git -C ~/claude/appbox reset --hard origin/main', /reset --hard/],
    ['git filter-branch --tree-filter x HEAD', /rewrites history/],
    ['git -c core.pager=sh log', /run a program/],
    ['git -c remote.origin.url=https://x push origin fix', /redirect/],
    ['git config remote.origin.url https://example.com/x.git', /redirect/],
    ['git log --output=/var/tmp/x', /writes a file/],
    ['GIT_EXTERNAL_DIFF=sh git diff', /GIT_EXTERNAL_DIFF/],
    ['xargs git push origin', /xargs git/],
    ["bash -c 'git push --force origin x'", /force/],
    ['/usr/bin/git push --force origin x', /force/],
    ['{git,} push origin main', /brace/],
    ['/usr/bin/g?t push origin main', /main directly/],
    // node
    ['node --test --import ./evil.mjs scripts/tests', /test-runner options/],
    ['NODE_OPTIONS=--require=./x.js node --test scripts/tests', /NODE_OPTIONS/],
    // wrappers and nesting
    ['watch -n 1 distrobox stop apps', /distrobox stop/],
    ['flock /var/tmp/l -c "distrobox rm apps"', /distrobox rm/],
    ["env -S 'distrobox rm apps'", /distrobox rm/],
    ['echo hi; distrobox rm apps', /distrobox rm/],
    ['true && podman rm -f apps', /apps/],
    ['echo $(distrobox rm apps)', /distrobox rm/],
    ["cat <<'EOF' | bash\ndistrobox rm apps\nEOF", /distrobox rm/],
];

for (const command of allowed) {
    test(`allows: ${command}`, () => {
        const r = checkCommand(command);
        assert.equal(r, null, `expected allow, got: ${r?.reason}`);
    });
}

for (const [command, why] of blocked) {
    test(`blocks: ${command}`, () => {
        const r = checkCommand(command);
        assert.ok(r?.blocked, 'expected the command to be blocked');
        assert.match(r.reason, why);
    });
}

test('machineScript tells host/install from coreutils install', () => {
    assert.equal(machineScript('host/install'), 'installer');
    assert.equal(machineScript('./install'), 'installer');
    assert.equal(machineScript('/home/u/claude/appbox/host/install'), 'installer');
    assert.equal(machineScript('install'), null);
    assert.equal(machineScript('install', true), 'installer');
    assert.equal(machineScript('/usr/bin/install'), null);
    assert.equal(machineScript('host/appbox-update.service'), null);
    assert.equal(machineScript('host/appbox-update'), 'updater');
});

test('isSecretPath keeps settings files and public keys readable', () => {
    for (const p of ['hosts/aurora-think.env', 'hosts/example.env', 'cosign.pub', '~/.ssh/id_ed25519.pub', 'docs/*']) {
        assert.equal(isSecretPath(p), false, p);
    }
    for (const p of ['.env', '.env.production', 'cosign.key', '/x/.ssh/id_rsa', '~/.config/gh/hosts.yml', 'tls.pem']) {
        assert.equal(isSecretPath(p), true, p);
    }
});

test('hook protocol: exit 0 allows', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
    assert.equal(r.status, 0, r.stderr);
});

test('hook protocol: exit 2 blocks with the reason on stderr', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'distrobox rm apps' } }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^guard-bash: Blocked: `distrobox rm`/);
    assert.match(r.stderr, /AGENTS\.md/);
});

test('hook protocol: --show-config is allowed end to end', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'host/appbox-update --show-config' } }));
    assert.equal(r.status, 0, r.stderr);
});

test('hook protocol: other tools pass through', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }));
    assert.equal(r.status, 0, r.stderr);
});

test('hook protocol: unreadable input fails closed', () => {
    const r = runHook('not json');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /fail closed/);
});

test('hook protocol: an empty command is allowed', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: '   ' } }));
    assert.equal(r.status, 0, r.stderr);
});

test('a long command line is decided within the time budget', () => {
    const command = Array.from({ length: 400 }, (_, i) => `echo ${i}`).join(' && ');
    const started = Date.now();
    assert.equal(checkCommand(command), null);
    assert.ok(Date.now() - started < 5000);
});

// --- The owner switch (APPBOX_OWNER_SESSION=1 in Claude Code's own environment) ---

// The machine-setup commands docs/install.md runs in an owner session.
const ownerAllowed = [
    'distrobox assemble create --file ~/claude/appbox/distrobox.ini',
    'distrobox assemble create --replace --file distrobox.ini',
    'distrobox assemble rm --file distrobox.ini',
    'distrobox stop ubuntu-signal',
    '~/claude/appbox/host/install',
    'host/install',
    '~/claude/appbox/host/appbox-update --force',
    'APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini host/appbox-update --force',
    'systemd-run --user --wait --collect ~/claude/appbox/host/appbox-update --force',
    'systemctl --user start appbox-update',
    'systemctl --user enable --now appbox-update.timer',
    'systemctl --user daemon-reload',
];

// Still refused in an owner session.
const ownerStillBlocked = [
    ['cat cosign.key', /secret/],
    ['cat ~/.ssh/id_ed25519', /secret/],
    ['git push --force origin fix/x', /force/],
    ['git push origin main', /main directly/],
    ['git reset --hard origin/main', /reset --hard/],
    ['git filter-branch --tree-filter x HEAD', /rewrites history/],
    ['podman system prune -a', /prune/],
    ['podman image prune -a', /prune/],
    ['podman rm -f apps', /apps/],
    ['podman rmi ghcr.io/danathar/appbox:latest', /appbox image/],
    ['distrobox rm --force ubuntu-signal', /distrobox rm/],
    ['distrobox upgrade --all', /distrobox upgrade/],
    ['pkill signal-desktop', /open app/],
    ['rm -rf ~/.config/Signal', /Signal or Claude data/],
    ['rpm-ostree install htop', /layers packages/],
    ['sudo ls', /privilege/],
    ['distrobox enter apps -- sudo apt-get install -y claude-desktop', /privilege/],
    ['source host/appbox-update', /sourcing/],
    ['scripts/appbox.sh', /image build/],
    ['scripts/claude-desktop-sync', /init hook/],
];

for (const command of ownerAllowed) {
    test(`owner session allows: ${command}`, () => {
        const r = asOwner(() => checkCommand(command));
        assert.equal(r, null, `expected allow in an owner session, got: ${r?.reason}`);
    });
    test(`without the owner switch, blocks: ${command}`, () => {
        const r = checkCommand(command);
        assert.ok(r?.blocked, 'expected a block outside an owner session');
        assert.match(r.reason, /APPBOX_OWNER_SESSION=1 claude/);
    });
}

for (const [command, why] of ownerStillBlocked) {
    test(`owner session still blocks: ${command}`, () => {
        const r = asOwner(() => checkCommand(command));
        assert.ok(r?.blocked, 'expected a block even in an owner session');
        assert.match(r.reason, why);
    });
}

// An agent cannot turn the switch on from inside a command.
const selfGranted = [
    'APPBOX_OWNER_SESSION=1 host/install',
    'export APPBOX_OWNER_SESSION=1; host/install',
    'export APPBOX_OWNER_SESSION=1 && host/appbox-update --force',
    'env APPBOX_OWNER_SESSION=1 host/appbox-update',
    "APPBOX_OWNER_SESSION=1 bash -c 'distrobox assemble create --file distrobox.ini'",
    'APPBOX_OWNER_SESSION=1 systemctl --user daemon-reload',
    'declare -x APPBOX_OWNER_SESSION=1; systemctl --user start appbox-update',
];
for (const command of selfGranted) {
    test(`setting the switch inside the command does nothing: ${command}`, () => {
        assert.ok(checkCommand(command)?.blocked);
    });
}

test('hook protocol: the switch comes from the hook process environment', () => {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: '~/claude/appbox/host/install' } });
    assert.equal(runHook(input).status, 2);
    assert.equal(runHook(input, { [OWNER_ENV]: '1' }).status, 0);
    assert.equal(runHook(input, { [OWNER_ENV]: 'yes' }).status, 2, 'only the value 1 turns it on');
    const inline = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'APPBOX_OWNER_SESSION=1 host/install' } });
    assert.equal(runHook(inline).status, 2);
});

test('hook protocol: an owner session still cannot read secrets', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat cosign.key' } }), { [OWNER_ENV]: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /secret/);
});

test('settings allow git branch only in the exact forms that list branches', () => {
    // A wildcard rule also allows `git branch -D`, `-f` and `-M`, which delete,
    // rewind or rename a local branch with no prompt. Only exact read forms may
    // be pre-approved.
    const settings = JSON.parse(readFileSync(new URL('../../settings.json', import.meta.url), 'utf8'));
    const rules = settings.permissions.allow.filter((rule) => rule.startsWith('Bash(git branch'));
    assert.deepEqual(rules, [
        'Bash(git branch)', 'Bash(git branch -a)', 'Bash(git branch -r)', 'Bash(git branch -v)',
        'Bash(git branch -vv)', 'Bash(git branch --list)', 'Bash(git branch --show-current)',
    ]);
    assert.ok(!settings.permissions.allow.some((rule) => /^Bash\(git branch.*:\*\)$/.test(rule)),
        'a wildcard git branch rule is back');
});
