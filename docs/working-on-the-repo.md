# Working on the repo

Read this before changing the repo from any machine. The short version:
**`main` is live.** Every enrolled machine fast-forwards its checkout to
`main` on its next timer run (nightly, or when a laptop wakes up) and runs
what it finds. There is no staging step.

## What a push does

| You change | CI rebuilds the image? | Reaches machines |
| --- | --- | --- |
| `ContainerFiles/`, `scripts/`, `packages/`, `keys/`, `cosign.pub`, the workflow | Yes, on push (and daily anyway) | New image on each machine's next recreate (weekly by default) |
| `host/appbox-update` | No | Next timer run, through self-update |
| `distrobox.ini`, `hosts/*.ini` | No | Next timer run; used at the next recreate |
| `hosts/<hostname>.env` | No | That machine's next timer run |
| `host/*.service`, `host/*.timer` | No | **Not until each machine runs `systemctl --user daemon-reload`** (re-running `host/install` does it). Self-update pulls the new file but systemd keeps the old one loaded. |
| `*.md`, `docs/` | No | Nothing to deploy |

Merging a Dependabot or Renovate PR is a push to `main` too.

## Before you push

- **Shell changes:** run shellcheck on what you touched
  (`podman run --rm -v "$PWD:/mnt:ro,z" -w /mnt docker.io/koalaman/shellcheck:stable host/appbox-update host/install scripts/*`).
- **Settings or ini changes:** run `host/appbox-update --show-config` on the
  affected machine, or with `APPBOX_SELF_UPDATE=0` and the variables set by
  hand, to see what it will use.
- **Image changes:** build locally first if you can
  (`podman build -f ContainerFiles/appbox -t localhost/appbox:test .`), then
  push and watch CI with `gh run watch`.
- **Order matters across the image and ini.** If an ini change depends on
  something new in the image (a new app to export), push the image change
  first, wait for CI to go green, and only then push the ini change.
  Otherwise a machine can recreate with the new ini and the old image, and
  the export fails.
- Write prose (docs and commit messages) without em dashes.

## Testing changes to the update script safely

`host/appbox-update` deletes and recreates the box. Never test it against
the real `apps` box while Signal or Claude is open, and check that yourself
(`pgrep -ax 'claude-desktop|signal-desktop'`) rather than taking anyone's
word for it.

- Use a throwaway ini pointing at an image that doesn't exist:
  `printf '[apps]\nimage=ghcr.io/danathar/does-not-exist:latest\n' > /tmp/t.ini`,
  then `APPBOX_SELF_UPDATE=0 APPBOX_INI=/tmp/t.ini host/appbox-update --force`.
  Anything that gets past the safety checks stops at the failed pull, before
  the box is touched.
- To fake a running app, name a process with `prctl`, not by renaming a
  binary (Ubuntu 26.04's coreutils refuses to run under another name):
  `podman exec -d apps python3 -c 'import ctypes,time; ctypes.CDLL(None).prctl(15, b"signal-desktop", 0, 0, 0); time.sleep(120)'`.
- To test self-update, use a scratch clone with a local bare remote, not a
  rollback of your real checkout. Rolling back also rolls back the script,
  so you end up testing the old version.
- `--force` skips only the age check. The running-app check always applies.

## Editing on an enrolled machine

The checkout the timer uses can also be the one you edit, but:

- **Commit and push promptly.** Uncommitted changes to files that `main` also
  changed make the nightly pull fail. Local commits that `main` doesn't have
  make it fail as soon as someone pushes from another machine. Either way
  the run continues with the local version and logs "Could not update ..." to
  `journalctl --user -u appbox-update`, so the machine silently stops
  following `main`.
- **Start with `git pull --rebase`**, and run it again before pushing.
- **On a machine you mostly develop on,** set `APPBOX_SELF_UPDATE=0` in its
  `hosts/<hostname>.env` and update it by hand with `git pull`.

## Never rewrite `main`

No force pushes, no rebases of pushed commits. Self-update only
fast-forwards, so after a rewrite every machine stops updating (the pull fails
every night, quietly). If history ever does get rewritten, fix each machine by
hand: `git -C ~/claude/appbox fetch && git -C ~/claude/appbox reset --hard origin/main`
(this discards local changes on that machine).

## Undoing a bad change

- **Script, ini, or settings:** `git revert` the commit and push. Machines
  pick it up on their next run.
- **Bad image:** `git revert` and let CI rebuild. To roll a machine back right
  away, point `image=` at an older dated tag (`ghcr.io/danathar/appbox:YYYYMMDD`)
  in that machine's ini and run
  `systemctl --user start appbox-update` after quitting the apps (or
  `host/appbox-update --force`).
- **Machine broken right now:** `distrobox assemble create --replace --file ~/claude/appbox/distrobox.ini`
  rebuilds the box directly. App data in `~/.config` is not touched.

## Rules for the image

- Never bake proprietary apps (Claude Desktop) into the image. The image is
  public. Add the vendor repo and install at box start from an init hook,
  like `scripts/claude-desktop-sync`.
- Init hooks must always exit 0. `distrobox-init` runs with `errexit`, so a
  failing hook keeps the box (and every app in it) from starting.
- Vendor keys go through `fetch_key` with a pinned fingerprint. Follow the
  vendor's current install instructions, not memory.
- Keep the shared `distrobox.ini` GPU-neutral. Per-machine needs go in
  `hosts/<hostname>.ini` and `hosts/<hostname>.env`.
- Use full `.desktop` paths in `exported_apps`, found with
  `dpkg -L <package> | grep '\.desktop$'`.

## Checking on a machine

```sh
~/claude/appbox/host/appbox-update --show-config   # settings in effect, checkout commit
systemctl --user list-timers appbox-update.timer    # next run
journalctl --user -u appbox-update -n 50            # what recent runs did
git -C ~/claude/appbox status -sb                   # is the checkout behind or diverged?
```

## Things you don't need

- The cosign private key. CI signs with the `SIGNING_SECRET` repo secret.
  The key is only needed to rotate it (see `docs/TODO.md`).
- To be on an enrolled machine. Any clone with push access, or GitHub's web
  editor, works.
