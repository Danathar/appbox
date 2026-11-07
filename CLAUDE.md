# appbox

@AGENTS.md

CI-built distrobox image (Signal, Claude Desktop) plus the host-side timer
that keeps each machine's `apps` box current. [AGENTS.md](AGENTS.md) is the
full guide for every agent and wins if this file disagrees with it. Read
`README.md` for how it works and `docs/working-on-the-repo.md` before changing
anything. To set up a new machine, follow `docs/install.md`; records of
machines already set up are in `hosts/*.md`.

Critical rules:

- `main` is live: every enrolled machine fast-forwards to it and runs it on
  its next timer run. Never force-push or rewrite `main`.
- Changed unit files (`host/*.service`, `host/*.timer`) need
  `systemctl --user daemon-reload` on each machine; self-update doesn't do it.
- Push an image change and wait for green CI before pushing an ini change
  that depends on it.
- Never bake Claude Desktop (or any proprietary app) into the image. It is
  public.
- An open app is never touched: no rebuild, no upgrade. Init hooks install
  only and never upgrade; upgrades happen in `host/appbox-update`, only for
  closed apps listed in `guarded_apps`.
- Never run `host/appbox-update` against the real box without first checking
  yourself that Signal and Claude are not running. Test with the throwaway
  ini method in `docs/working-on-the-repo.md`. As an agent, do not run it at
  all (only `--show-config`): use `bats tests/unit` and `tests/e2e/`, and leave
  real-machine tests to the owner. The guard hook enforces this, except in a
  machine-setup session the owner started as `APPBOX_OWNER_SESSION=1 claude`.
- Ask before anything destructive on a host. Don't layer packages with
  rpm-ostree.
- Per-machine settings go in `hosts/<hostname>.env`, per-machine records in
  `hosts/<hostname>.md`.
- No em dashes in docs or commit messages.

Claude Code specifics:

- Skills in `.claude/skills/`: `run-checks`, `add-an-app`,
  `test-update-script-safely`.
- `.claude/settings.json` denies secret reads and dangerous commands, and
  `.claude/hooks/guard-bash.mjs` checks every Bash call (see "The Bash guard"
  in AGENTS.md).
- Start a session with `.claude/session-summary.md` and the index in
  `.claude/memory/README.md`. Only the session that lands work on `main`
  rewrites the summary; otherwise put handoff notes in the PR body.
- `git commit -s`, and `-R Danathar/appbox` on every `gh` command.

Open follow-ups: `docs/TODO.md`.
