# AGENTS.md

The instructions every AI coding agent follows in this repository (Claude
Code, GitHub Copilot, Cursor, Codex, hive agents, others). The tool-specific
files ([CLAUDE.md](CLAUDE.md),
[.github/copilot-instructions.md](.github/copilot-instructions.md),
[.cursor/rules/appbox.mdc](.cursor/rules/appbox.mdc)) only point here and
repeat the most important rules. If one of them disagrees with this file,
this file wins.

## What appbox is

Two halves that ship from the same repository:

1. **The image**, `ghcr.io/danathar/appbox`: a distrobox image on Ubuntu LTS
   (`ghcr.io/ublue-os/ubuntu-toolbox`), built by CI daily, on push to `main`
   and on demand, and signed with cosign. Signal Desktop is baked in. Claude
   Desktop is proprietary, so the public image carries only Anthropic's apt
   key and source; an init hook (`scripts/claude-desktop-sync`) installs the
   package the first time a new box starts.
2. **The host side**, `host/appbox-update`: a script run daily by a systemd
   user timer on each enrolled machine. It fast-forwards its own checkout of
   this repo, rebuilds the `apps` box from the latest verified image once it
   is 7 days old, and otherwise upgrades Signal and Claude in place inside
   the box. **An app that is open is never touched**: no rebuild, no upgrade.

**`main` is live.** Every enrolled machine pulls `main` on its next timer run
(nightly, or when a laptop wakes) and runs what it finds. There is no staging
step. A merge to `main` is a deploy to every machine. That is the reason for
most of the rules below. [docs/working-on-the-repo.md](docs/working-on-the-repo.md)
explains what each kind of change deploys and when; read it before changing
anything that machines run.

Licence: GPL-3.0-only (parts from the boxkit template also Apache-2.0; see README). Default branch: `main`. Repository: `Danathar/appbox`.

## Where things live

| Path                          | What it is                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `ContainerFiles/appbox`       | Image definition; the `FROM` line and the `UBUNTU_VERSION` guard.                         |
| `scripts/appbox.sh`           | Build-time setup inside the image: apt repos, pinned vendor keys, Signal, baked packages. |
| `scripts/claude-desktop-sync` | Box-start init hook: installs Claude Desktop if missing. Install only, always exits 0.    |
| `packages/appbox.packages`    | Extra Ubuntu packages baked into the image, one per line.                                 |
| `keys/`, `cosign.pub`         | ublue's public key (CI refuses an unsigned base) and appbox's own signing public key.     |
| `distrobox.ini`               | The shared `apps` box definition (GPU-neutral), including `exported_apps`.                |
| `host/`                       | `appbox-update`, its `.service` and `.timer`, and `install` (enrols a machine).           |
| `hosts/`                      | Per-machine `<hostname>.env` settings, `<hostname>.md` setup records, `example.env`.      |
| `.github/workflows/`          | `build-appbox.yml` builds, signs and pushes the image; the rest is CI and automation.     |
| `tests/unit/`, `tests/e2e/`   | bats unit tests for the shell scripts (stubbed commands); end-to-end checks of the image. |
| `scripts/*.mjs`               | Node tooling for CI and automation (tests in `scripts/tests/`). Not part of the image.    |
| `docs/`                       | Install guide, working on the repo, TODO, risk tiers, agent boundaries, task ledgers.     |
| `.claude/`                    | Agent settings and guard hook, skills, correction memory, session summary.                |

## Hard rules

These hold for every change and every session. Each comes from something
that would break a real machine.

- **Never force-push, rebase or otherwise rewrite `main`.** Self-update only
  fast-forwards, so after a rewrite every machine silently stops updating.
  Never push to `main` directly either: push a branch and open a pull request.
- **Never bake a proprietary app into the image.** The image is public. A
  proprietary app gets its vendor repo in the image and is installed at box
  start from an install-only init hook, like `scripts/claude-desktop-sync`.
  Signal (AGPL-3.0) may be baked in; Claude Desktop may not.
- **An open app is never touched.** Init hooks install only and never
  upgrade, because a box usually starts because an app was just clicked.
  Upgrades happen only in `host/appbox-update`, only for closed apps listed in
  `guarded_apps`. Closing a window leaves Signal and Claude running in the
  tray, which still counts as open.
- **Init hooks always exit 0.** `distrobox-init` runs with `errexit`, so a
  failing hook keeps the box, and every app in it, from starting.
- **Never run `host/appbox-update` or `host/install` on a real machine.** The
  update script deletes and recreates the box and upgrades apps inside it;
  `host/install` enables the timer. Agents test the script with `bats
  tests/unit` and `tests/e2e/` only. The one exception is
  `host/appbox-update --show-config`, which prints the settings in effect and
  changes nothing. The throwaway-ini method in
  [docs/working-on-the-repo.md](docs/working-on-the-repo.md) is for the owner
  to run by hand, after checking for themself that Signal and Claude are
  closed; see "The Bash guard" below for why agents may not run it. A
  session the owner starts for machine setup (`APPBOX_OWNER_SESSION=1 claude`,
  see "The owner switch" below) may run what `docs/install.md` runs.
- **Never call a function that must abort on failure as `func && ...` or
  `if func`.** Bash turns `errexit` off inside it, so a failed pull or
  signature check would carry on. `rebuild_box` reports a skipped rebuild
  through the `rebuild_skipped` variable for this reason; keep that shape.
- **An image change must be green before an ini change that depends on it.**
  If a new `exported_apps` entry needs something new in the image, the image
  change merges first and CI must build and sign it before the ini change
  merges. Otherwise a machine can recreate with the new ini and the old image.
- **Unit file changes need `systemctl --user daemon-reload` on each
  machine.** Self-update pulls a changed `host/*.service` or `host/*.timer`,
  but systemd keeps the old one loaded until the owner reloads (re-running
  `host/install` does it). Say so in the PR.
- **Never layer packages with rpm-ostree**, and never install anything on the
  host. Ask the owner before anything destructive on a host: removing or
  recreating boxes, deleting data or launchers, changing timers.
- **Keep the shared `distrobox.ini` GPU-neutral.** Per-machine needs go in
  `hosts/<hostname>.ini` and `hosts/<hostname>.env`.
- **Vendor keys go through `fetch_key` with a pinned fingerprint**, following
  the vendor's current install instructions, not memory.
- **Never read secrets** (`.env`, `cosign.key` or any private key, `~/.ssh`,
  `~/.config/gh`, `~/.config/appbox-signing`, tokens). Move them without
  looking (`gh secret set NAME -R Danathar/appbox < FILE`) and verify keys
  through their public half (`cosign public-key --key FILE`).
- **No em dashes** anywhere: docs, code comments, commit messages, PR text.
  Use commas, colons, parentheses or a new sentence.
- Every `gh` command passes `-R Danathar/appbox`.

## Risk tiers

Every change is classified by what it can break; the highest tier any touched
path matches applies. The full table and its reasoning are in
[docs/risk-tiers.md](docs/risk-tiers.md); what an agent may do at each tier
is in [docs/agent-boundaries.md](docs/agent-boundaries.md).

- **Tier 0:** docs, tests, `.claude/memory/`, `docs/reflections/`. Needs
  green required checks.
- **Tier 1:** CI and tooling: `.github/workflows/` other than the build,
  `scripts/*.mjs`, `policies/`, `.claude/` config. Needs green required
  checks, and tests for any tooling change.
- **Tier 2:** anything machines run or the image contains: `host/`,
  `hosts/`, `distrobox.ini`, `ContainerFiles/`, `scripts/appbox.sh`,
  `scripts/claude-desktop-sync`, `packages/`, `keys/`, `cosign.pub`,
  `.github/workflows/build-appbox.yml`, and the agent boundary itself,
  `.claude/settings.json` and `.claude/hooks/**`. Highest scrutiny: the
  reviewer agent reviews it, tests cover the change, and the PR states its
  machine impact (daemon-reload needed, image green before a dependent ini
  change).

appbox runs on a fully autonomous hive, so **no tier has a human-merge gate**.
An agent PR merges once the required checks pass, Tier 2 included. Tier 2
means more scrutiny, not a person clicking merge. The owner's brake is the
`hold` label: a PR carrying `hold` does not merge, and an agent never removes
it.

## Running the checks

Run these from the repo root before opening a PR and report the exact
commands and results in it. CI (`.github/workflows/ci.yml`) runs the same
checks; its aggregate job `test` is the required status check.

```sh
# Shell lint (config in .shellcheckrc)
shellcheck host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync
# or, without a local shellcheck:
podman run --rm -v "$PWD:/mnt:ro,z" -w /mnt docker.io/koalaman/shellcheck:stable \
    host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync

bats tests/unit                                  # unit tests, stubbed commands only
node --test scripts/tests .claude/hooks/tests    # node tooling and the guard hook
actionlint                                       # after editing workflows
```

`tests/e2e/` holds the end-to-end checks CI runs against a freshly built
image; see the files there and the e2e job in `.github/workflows/ci.yml` for
how to run them. Run them when you touch the image. A local image build
(`podman build -f ContainerFiles/appbox -t localhost/appbox:test .`) is
optional; tag it `localhost/appbox:test` so it can never be mistaken for the
real image.

Add or update a bats test for every behaviour change to a shell script. If a
tool is missing locally, say so in the PR; never substitute running the real
script.

## Commits and pull requests

- Sign off every commit (`git commit -s`). The DCO check rejects a commit
  without a `Signed-off-by` trailer.
- Work on a branch and push it by name: `git push -u origin <branch>`.
- Open the PR with `gh pr create -R Danathar/appbox --base main --body-file FILE`.
  Use `--body-file`, not `--body "..."`: the guard hook reads quoted text
  handed to `gh` as a possible command, so a body that mentions a blocked
  command is refused.
- Follow the PR template: a plain-language summary first, the tier and
  paths touched, the **machine impact** (what reaches machines and when;
  daemon-reload needed; image-before-ini order), the checks you ran with
  results, and what you could not verify. Say that an AI agent prepared it.
- Close issues with one `Fixes #N` line each. Do not write "closes", "fixes"
  or "resolves" next to any other issue number.
- Do not merge your own PR, approve PRs, change labels, settings, rulesets or
  secrets, or remove a `hold` label.
- Disclose any change beyond what was asked.

## The Bash guard

`.claude/settings.json` denies secret reads, force pushes, pushes to `main`,
history rewrites, prunes, `sudo` and `rpm-ostree` layering by prefix (a deny
there cannot be overridden by anything), and registers `.claude/hooks/guard-bash.mjs` on every Bash call. The hook reads
the command the way the shell would (through `env`, `timeout`, `bash -c`,
absolute paths, wrappers and nesting) and refuses:

- running `host/appbox-update` (except `--show-config`), `host/install`,
  `scripts/appbox.sh` or `scripts/claude-desktop-sync` (the first two are
  allowed in an owner session, below);
- `distrobox rm`, `stop`, `upgrade`, `assemble rm`, and `assemble create`
  without `--dry-run` (the repo's ini sets `replace=true`, so it deletes the
  existing box first); removing, stopping or killing the `apps` box or a
  `ghcr.io/danathar/appbox` image; prunes and `--all` removals; `pkill` of
  Signal or Claude; deleting live app data or launchers;
- `systemctl` changes to appbox units and `systemctl --user daemon-reload`;
- `sudo` and friends, `rpm-ostree` layering, package changes with apt or dpkg;
- printing a secret file;
- force pushes, pushes to `main`, pushes without a named branch,
  `git reset --hard` and history rewrites.

**Why the throwaway-ini test is blocked for agents.** The documented method
(`APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini host/appbox-update --force` with
an ini naming an image that does not exist) is safe only if the ini really
names a missing image and a box other than the real one, and only after a
person has checked that no guarded app is open. A hook cannot verify either:
the ini can be written in the same command and can name `[apps]` and the
real image. Even a run that stops at the failed pull first inspects the real
box and can write notification state under `~/.local/state/appbox`. So the
hook refuses every real run, and the owner runs that test by hand.

**The owner switch.** Setting up a machine (`docs/new-machine-prompt.md`,
which follows `docs/install.md`) needs commands the hook otherwise refuses:
`distrobox assemble create`, `distrobox stop <old-box>`, `host/install`,
`host/appbox-update --force` (also through
`systemd-run --user --wait --collect`), and `systemctl --user` for the appbox
units, including `daemon-reload`. When the owner starts Claude Code as
`APPBOX_OWNER_SESSION=1 claude`, the hook (which inherits Claude Code's
environment, not the command's) allows exactly those. Nothing an agent types
can turn it on: `APPBOX_OWNER_SESSION=1 host/install` or an `export` inside a
Bash call sets the variable for that command only, and the hook ignores it.
The switch never relaxes secret reads, force pushes, pushes to `main` or
history rewrites, prunes and `--all` removals, removal of the `apps` box or
its image, `distrobox rm` or `upgrade`, `pkill` of the apps, deleting app data,
`sudo`, `rpm-ostree` layering, or apt and dpkg changes. Hive agents and
everyday sessions never run with it, and no agent sets it in a settings file's
`env` (`.claude/settings.local.json` edits ask first for that reason).

The hook catches mistakes by an agent that is following these rules. It is
not a sandbox against an agent trying to get around it. Do not file, or fix
unprompted, findings that need a disguised spelling nobody types in ordinary
work (quotes inside a word, brace or wildcard tricks, `$'...'` escapes,
variables or substitutions that build the command name). These are in scope
and worth an issue: the hook crashing or timing out (it fails closed, so
that shows up as a block), an ordinary spelling getting through (plain name,
full path, a documented option or alias, a wrapper such as `timeout` or
`xargs`), a regression in a case the tests in `.claude/hooks/tests/` cover,
and the hook blocking normal work. Changes to the hook or settings are Tier 2
and need tests.

`.claude/hooks/shell-reader.mjs` is shared byte for byte with the other
repositories that carry this guard (canonical copy in Danathar/akmods), and
`shell-reader.test.mjs` pins its hash. Make reading fixes there first.

## Session continuity

Start a session by reading [.claude/session-summary.md](.claude/session-summary.md),
the index in [.claude/memory/README.md](.claude/memory/README.md) and recent
`git log origin/main`. Only the session that lands work on `main` rewrites the
summary; a session that opens a PR to be merged later puts its handoff notes
in the PR body, so concurrent PRs do not conflict. Record a mistake worth
never repeating in `.claude/memory/` (format in its README). Record which
issue became which PR in [docs/agent-tasks/](docs/agent-tasks/README.md).
These are the shared handoff points for every agent, not only Claude.

## Agent tooling in this repo

| Path                              | What it is                                                                  |
| --------------------------------- | --------------------------------------------------------------------------- |
| `AGENTS.md`                       | This file: the source of truth for every agent.                             |
| `CLAUDE.md`                       | Claude Code entry point; imports this file and keeps the critical rules.    |
| `.github/copilot-instructions.md` | Copilot instructions (points here).                                         |
| `.cursor/rules/appbox.mdc`        | Cursor rule, always applied (points here).                                  |
| `.github/prompts/`                | Reusable prompts: Ubuntu release upgrade, failed build triage, PR review.   |
| `.claude/skills/`                 | Claude skills: `run-checks`, `add-an-app`, `test-update-script-safely`.     |
| `.claude/settings.json`           | Permissions (secret reads and dangerous commands denied) and the Bash hook. |
| `.claude/hooks/`                  | `guard-bash.mjs`, the shared `shell-reader.mjs`, and their tests.           |
| `.claude/memory/`                 | Correction memory: mistakes made or nearly made here, with evidence.        |
| `.claude/session-summary.md`      | Current state for the next session.                                         |
| `docs/agent-boundaries.md`        | What an agent may change alone, by tier.                                    |
| `docs/agent-tasks/`               | Task ledgers: issue to PR to outcome, one file per session.                 |
| `.github/CODEOWNERS`              | `@Danathar` owns everything; Tier 2 paths listed for visibility.            |
