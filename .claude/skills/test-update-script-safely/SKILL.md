---
name: test-update-script-safely
description: Test a change to host/appbox-update without touching a real apps box, using stubbed bats tests, and hand the owner the real-machine steps from docs/working-on-the-repo.md.
---

# test-update-script-safely

`host/appbox-update` deletes and recreates the `apps` box and upgrades apps
inside it. Agents never run it for real; `host/appbox-update --show-config`
is the only run allowed (it prints the settings and exits before it touches
git, podman or the box). The guard hook refuses every other run.

## What you do

1. Write or update bats cases in `tests/unit/` that cover the change. Those
   tests run the script against stubbed commands (`podman`, `distrobox`,
   `cosign`, `notify-send` and the like; see the helpers in `tests/unit/`),
   so nothing reaches a real box. Follow the existing cases.
   Cover both sides of every safety decision: app open versus closed, box
   younger versus older than `APPBOX_MAX_AGE_DAYS`, pull or verify failing.
2. Keep the errexit shape. Never call a function that must abort on failure
   as `func && ...` or `if func`: bash turns `errexit` off inside it. That is
   why `rebuild_box` reports a skipped rebuild through `rebuild_skipped`. A
   bats case where the stubbed pull or `cosign verify` fails and the script
   exits non-zero proves the shape is intact.
3. Treat a failed `podman inspect` as "app running": the script never guesses
   "safe".
4. Run `shellcheck host/appbox-update` and `bats tests/unit` (see the
   `run-checks` skill).

## What the owner does on a real machine

Put these in the PR body as the owner's test plan, from
`docs/working-on-the-repo.md` ("Testing changes to the update script
safely"); do not run them:

- First check by hand that Signal and Claude are closed:
  `pgrep -ax 'claude-desktop|signal-desktop'`.
- Throwaway ini pointing at an image that does not exist, so anything that
  gets past the safety checks stops at the failed pull:
  `printf '[apps]\nimage=ghcr.io/danathar/does-not-exist:latest\n' > /tmp/t.ini`,
  then `APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini host/appbox-update --force`.
- To fake a running app, name a process with `prctl`, not a renamed binary
  (Ubuntu 26.04's coreutils refuses to run under another name).
- In-place upgrades: install an older app version in the closed box, then run
  `APPBOX_SELF_UPDATE=0 host/appbox-update`. Never downgrade Signal and then
  open it.
- Self-update: a scratch clone with a local bare remote, never a rollback of
  the real checkout.

State the machine impact in the PR: the script reaches every machine on its
next timer run through self-update, with no daemon-reload needed unless a
unit file changed too.
