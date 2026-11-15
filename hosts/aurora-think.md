# aurora-think (laptop)

Setup record for the first host moved onto appbox, done 2026-11-07, with its
first week of running on its own (to 2026-11-15). It covers what was there
before, what was changed, how the host is configured now, and what was
learned along the way.

## Host

| | |
| --- | --- |
| Hardware | Laptop, Intel UHD Graphics 620 (Kaby Lake-R). Lid is usually closed overnight. |
| OS | Aurora DX, `ghcr.io/ublue-os/aurora-dx:stable`, 45.20261113.1 (upgraded from 44.20261103.1 on 2026-11-15), kernel 7.2.11-300.fc45 |
| Desktop | KDE Plasma 6 on Wayland, KWallet 6 |
| Tools | podman 6.1.3 (5.8.9 at setup), distrobox 1.8.2.5, cosign v3.1.4 (Homebrew), gh logged in as Danathar |
| OS updates | `uupd.timer` at 04:00, stages a new image, applied on reboot. Its distrobox module is disabled in `/etc/uupd/config.json`, so it does not touch the `apps` box. |

## Before

- A hand-maintained box, `ubuntu-signal` (`docker.io/library/ubuntu:22.04`),
  created with a custom home, `--home ~/ubuntu-signal`. It held Signal Desktop
  8.34.0 and Claude Desktop 4.23118.0, exported as
  `ubuntu-signal-signal-desktop.desktop` and
  `ubuntu-signal-com.anthropic.Claude.desktop`.
- Because of the custom home, app data lived under `~/ubuntu-signal/.config/`
  (Signal 5.2 GB, Claude 737 MB), not `~/.config/`.
- Signal's database key is stored in KWallet (`"safeStorageBackend": "kwallet6"`
  in Signal's `config.json`).
- Other boxes, all left untouched: `arch-container`, `ubuntu-lts`,
  `my-distrobox`, `debian-13`, plus podman containers `fedora-toolbox-42` and
  `bootc-build`.

## What was done

1. Created `Danathar/appbox` from `ublue-os/boxkit`, removed the template's
   examples, and wrote the image, CI workflow, `distrobox.ini`, and host
   timer described in the [README](../README.md).
2. Generated a cosign keypair with an empty password in
   `~/.config/appbox-signing/` (directory mode 700, `cosign.key` mode 600).
   The private key went into the `SIGNING_SECRET` repo secret; `cosign.pub`
   is committed.
3. The first CI run passed. The ghcr package came out public on its own
   (it inherits the repo's visibility through the image source label), and
   `cosign verify --key cosign.pub ghcr.io/danathar/appbox:latest` passes.
4. Created the `apps` box with `distrobox assemble create --file distrobox.ini`.
   It uses the normal home directory, so app data is in `~/.config/Signal` and
   `~/.config/Claude`.
5. Migrated data: quit both apps, confirmed no processes or `SingletonLock`
   files, stopped `ubuntu-signal` with `distrobox stop` (not removed), then
   copied (not moved) with
   `rsync -aHAX ~/ubuntu-signal/.config/{Signal,Claude} ~/.config/`.
   The originals are still in `~/ubuntu-signal/.config/`.
6. Tested: Signal opened linked with full history and Claude was logged in,
   both before and after recreating the box (by hand and through the timer's
   script under systemd).
7. Installed the timer by symlinking `host/appbox-update.{service,timer}` into
   `~/.config/systemd/user/` and ran `systemctl --user enable --now appbox-update.timer`.
8. Same day, switched to central management: the script now fast-forwards
   the checkout on every run and reads this machine's settings from
   [`hosts/aurora-think.env`](aurora-think.env). Re-ran `host/install`, which
   now does step 7 and prints the effective settings.
9. Same day, closed the update gaps: the daily run now upgrades Signal and
   Claude in place whenever they are closed, notifies once per new version
   when one is open, and nudges once when a weekly rebuild is first skipped.
   The box-start hook became install-only. Tested on this machine against the
   real box: a closed, downgraded Claude was upgraded; an open one was left
   alone with a single notification and upgraded once closed; the 7- and
   14-day nudges fired as designed; and `notify-send` works from the systemd
   user service.

## First week (2026-11-08 to 2026-11-15)

The timer ran on Nov 8, 9, 11 and 15, each time right after the lid opened
(days with no run were days the laptop was not opened). No run failed.

- **Open apps were left alone, as designed.** Signal and Claude stayed open
  from about Nov 9, so every run logged "available, but ... is running" and
  notified once per new version: Claude 4.23118.1, 5.1231.2 and 5.11492.5,
  Signal 8.35.0. On Nov 15 the box reached 8 days, the rebuild was skipped
  because Signal was open, and the "Weekly apps update is waiting" nudge
  fired.
- **Self-update failed on every run.** Each run logged
  `Could not resolve host: github.com` and carried on with `3f0a896`: the pull
  ran before anything waited for the network, and right after resume DNS was
  not up yet (the apt check a few seconds later worked). The checkout fell
  44 commits behind `main`. Fixed in #124 (wait up to about two minutes for
  the remote before pulling). Before pulling, the owner had the host-side
  changes in those 44 commits reviewed: `host/appbox-update` (refuse a
  multi-section ini, retry the ini's own init hook, notification names, and
  #70, a fix for every successful rebuild exiting 1 and being re-run two
  minutes later), a comment in `distrobox.ini`, and stricter
  `.claude/settings.json` and Bash guard. `host/install`, the units, `hosts/`
  and the box-start hook were unchanged.
- **Aurora 44 to 45, 2026-11-15.** After the reboot (12:03), the first box
  start (Signal launched at 12:04:54) ran the old image's box-start hook,
  which still upgraded Claude in the background (4.23118.0 to 5.11492.5 at
  12:05:16). Expected: that hook predates the install-only one, and only a
  rebuild onto a newer image replaces it.
- **Rebuild, 2026-11-15 12:21.** With the checkout pulled to `0ac5627` (#124)
  and both apps quit, the owner ran `systemctl --user start appbox-update`.
  It verified and rebuilt from
  `ghcr.io/danathar/appbox@sha256:388b5a73eb43c782e7126376eaf2c8180cb40588218bfa2596110654af1321ee`
  (built 2026-11-15 16:32 UTC) in 1 min 19 s, exited 0, re-exported both
  launchers, removed the old image and cleared the notification state. The
  new box has Signal 8.35.0, Claude 5.11492.5 and the install-only hook.
- **Launcher icon lost after the rebuild.** "Claude (on apps)" showed the
  wrong icon although its icon files and `Icon=claude-desktop` were correct
  (Signal had done the same earlier, fixed then by a manual re-export).
  Cause: the rebuild deletes and re-exports the icons while Plasma is running,
  and Plasma kept its cached lookup. Fixed without re-exporting by
  `dbus-send --session --type=signal /KIconLoader org.kde.KIconLoader.iconChanged int32:0`
  and `kbuildsycoca6 --noincremental`. #125 makes every rebuild do this.

## Current configuration

Settings: [`hosts/aurora-think.env`](aurora-think.env) (defaults: rebuild
weekly, upgrade closed apps daily, self-update on). Notification state is in
`~/.local/state/appbox/`. Check what is in effect with
`~/claude/appbox/host/appbox-update --show-config`.

| Path | What |
| --- | --- |
| `~/claude/appbox` | Repo checkout. The service runs `host/appbox-update` from here, and the script fast-forwards it on every run. This is also where changes are made, so commit and push promptly; uncommitted edits can make the timer's pull fail (it then carries on with the local version). |
| `~/.config/systemd/user/appbox-update.{service,timer}` | Symlinks into the checkout, made by `host/install`. No drop-in, since the checkout is at the default path. |
| `~/.config/appbox-signing/cosign.key` | Private signing key. Not in git. Back it up; losing it means generating a new pair and updating `cosign.pub` and `SIGNING_SECRET`. |
| `~/.config/Signal`, `~/.config/Claude` | Live app data, used by the `apps` box. |
| `~/.local/share/applications/apps-*.desktop` | Exported launchers ("Signal (on apps)", "Claude (on apps)"). |

### Cleanup

After the migration was confirmed, the same day:

- `distrobox rm --force ubuntu-signal` removed the old box and its exported
  launchers.
- `rm -rf ~/ubuntu-signal` removed the old home (5.9 GB). Besides the copied
  Signal and Claude data, it held nothing worth keeping: shell dotfiles,
  caches, a GPG keyring with no keys, and one Claude Code session transcript
  from a scratch workspace.

Still present: `~/.gnupg/`, created by a `gpg --show-keys` fingerprint check
during setup. It only contains an empty trustdb and is harmless.

## Cowork

Cowork is Claude Desktop's agent mode that runs tasks in a local sandboxed VM.
It is not used on this host, but its prerequisites were checked inside the box:
`kvm-ok` reports KVM usable, `/dev/kvm` and `/dev/vhost-vsock` are
accessible, `vhost_vsock` autoloads on first open, and qemu starts with KVM
acceleration and a vhost-vsock device. A real Cowork task has not been run
(its VM bundle has never been downloaded on this host).

## Lessons learned

These shaped the design and are worth knowing on the next host.

- `ghcr.io/ublue-os/ubuntu-toolbox` only publishes `:latest` (Ubuntu 26.04 as
  of this setup), hence the `UBUNTU_VERSION` guard instead of a pinned tag.
- `distrobox-init` runs with `errexit`, so a failing init hook stops the box
  from starting. `claude-desktop-sync` always exits 0 for that reason.
- `exported_apps` matches by grepping `Exec=` and `Name=` lines, so the ini
  uses full `.desktop` paths to be exact.
- Claude Desktop's Recommends pull in about 200 packages (qemu, OVMF,
  virtiofsd for Cowork). They are pre-installed in the image so a box-start
  install is one package and about 25 seconds.
- distrobox boxes run with `--pid host`, so `pgrep` inside a box sees every
  box's processes. KDE also moves an app's main process into its own
  `app-*.scope` cgroup, so cgroups cannot identify the box either. Comparing
  mount namespaces (`/proc/PID/ns/mnt`) with the box's init process works.
- `distrobox assemble --replace` deletes the box before creating it, so a
  pull that fails afterwards would leave no box. The update script pulls and
  verifies first, then creates from the pinned digest with `pull=false`.
- After a recreate from the systemd service, the box ends up stopped
  (`Exited (143)`): systemd cleans up the unit's processes when the oneshot
  finishes. This is harmless. The next launcher click starts it again in
  about a second.
- The first design upgraded Claude in the background from the box-start
  hook. The box usually starts because an app was just clicked, so that
  replaced files under a starting app. Upgrades moved to the host timer,
  which can see whether each app is open.
- `func && ...` (and `if func`) turns off bash's `errexit` inside `func`. An
  early draft called the rebuild that way, which would have let a failed pull
  or signature check carry on. Caught in review, before it ran.
- Ubuntu 26.04's coreutils is a single multicall binary that resolves its
  own path, so a renamed copy of `sleep` cannot fake a process name in tests.
  Use `prctl(PR_SET_NAME)` instead.
- On this host `ls` is aliased to `eza`, which hung once in a scripted call.
  Use `command ls` in scripts.
- Anything on the network at the start of a lid-open run needs to wait for
  the network: the timer fires the moment the laptop wakes. The image pull
  always waited; the self-update pull did not until #124, and a failure there
  is silent apart from the journal.
- Check `git -C ~/claude/appbox status -sb` (after a `git fetch`) when
  something looks stale: "behind N" means self-update is not working.
- A rebuild deletes and re-adds the exported icons, and Plasma caches icon
  lookups. A wrong launcher icon right after a rebuild is a cache problem,
  not a broken export: reload Plasma's icons rather than re-exporting.
- The first rebuild after a change to `scripts/claude-desktop-sync` is what
  delivers it: until then the box keeps the hook from its old image.
