# aurora-think (laptop)

Setup record for the first host moved onto appbox, done 2026-11-07. It covers
what was there before, what was changed, how the host is configured now, and
what was learned along the way.

## Host

| | |
| --- | --- |
| Hardware | Laptop, Intel UHD Graphics 620 (Kaby Lake-R). Lid is usually closed overnight. |
| OS | Aurora DX, `ghcr.io/ublue-os/aurora-dx:stable`, 44.20261103.1, kernel 7.2.11 |
| Desktop | KDE Plasma 6 on Wayland, KWallet 6 |
| Tools | podman 5.8.9, distrobox 1.8.2.5, cosign v3.1.4 (Homebrew), gh logged in as Danathar |
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
   timer described in the [README](../../README.md).
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

## Current configuration

| Path | What |
| --- | --- |
| `~/claude/appbox` | Repo checkout. The service runs `host/appbox-update` from here. |
| `~/.config/systemd/user/appbox-update.{service,timer}` | Symlinks into the checkout. |
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
- Ubuntu 26.04's coreutils is a single multicall binary that resolves its
  own path, so a renamed copy of `sleep` cannot fake a process name in tests.
  Use `prctl(PR_SET_NAME)` instead.
- On this host `ls` is aliased to `eza`, which hung once in a scripted call.
  Use `command ls` in scripts.
