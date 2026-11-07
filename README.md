# appbox

A CI-built [distrobox](https://distrobox.it/) image for running desktop apps
(currently Signal Desktop and Claude Desktop) on an atomic Fedora host, without
hand-maintaining a pet container. Built with the
[boxkit](https://github.com/ublue-os/boxkit) pattern on top of
[`ghcr.io/ublue-os/ubuntu-toolbox`](https://github.com/ublue-os/toolboxes),
which already carries the distrobox host-integration pieces.

- Image: `ghcr.io/danathar/appbox` (`:latest`, plus a dated tag such as `:20261107` for every build)
- Built daily, on push to `main`, and on demand (`gh workflow run build-appbox`)
- Signed with cosign; see [Verifying the image](#verifying-the-image)

## Layout

| Path | What it is |
| --- | --- |
| `ContainerFiles/appbox` | The image definition. `FROM` line and `UBUNTU_VERSION` guard live here. |
| `scripts/appbox.sh` | Build-time setup: apt repos, keys, Signal, baked packages. |
| `scripts/claude-desktop-sync` | Installs or upgrades Claude Desktop at box start (baked into the image). |
| `packages/appbox.packages` | Extra Ubuntu packages to bake in, one per line. |
| `keys/ublue-os-toolboxes.pub` | ublue's public key; CI refuses to build on an unsigned base. |
| `distrobox.ini` | Box definition for `distrobox assemble`, including exported launchers. |
| `host/` | The update script, its systemd user service and timer, and `host/install` to set them up. Shared by every machine. |
| `hosts/` | One `<hostname>.env` (settings) and `<hostname>.md` (setup record) per machine, plus `example.env` as the template. |

## What is baked in vs installed at box start

| App | Where | Why |
| --- | --- | --- |
| Signal Desktop | Baked into the image | AGPL-3.0, fine to redistribute. Launches immediately after a recreate. |
| Claude Desktop | Installed by `init_hooks` on every box start | Proprietary. The public image only carries Anthropic's apt key and source, never the package. |

The image does pre-install Claude Desktop's dependencies (all from the Ubuntu
archive, including the qemu/OVMF/virtiofsd stack Cowork uses), so the
box-start install only downloads the app itself. On the first start of a new
box it installs synchronously so the launcher can be exported. On later starts
it upgrades in the background and logs to `/var/log/appbox-claude-sync.log`
inside the box. The hook always exits 0, because a failing init hook would
stop the box (and Signal) from starting, for example when booting offline.

Signal's official apt repo is **amd64 only**, so this image is built for
amd64 only. Claude Desktop's repo also has arm64, but Signal would need a
different source (Flatpak or AppImage) on an arm64 host.

## Using it on a machine

**Setting up a new machine, including moving data out of existing boxes:**
follow [`docs/install.md`](docs/install.md). To have Claude Code do it, paste
[`docs/new-machine-prompt.md`](docs/new-machine-prompt.md) into a session on
that machine. Before changing the repo from any machine, read
[`docs/working-on-the-repo.md`](docs/working-on-the-repo.md).

Works as-is on Intel and AMD GPUs (Mesa is in the base image). An NVIDIA
machine needs `nvidia=true`; give it its own `hosts/<hostname>.ini` rather
than changing the shared `distrobox.ini`.

The short version:

```sh
git clone https://github.com/Danathar/appbox ~/claude/appbox
cd ~/claude/appbox
distrobox assemble create --file distrobox.ini
```

That creates a box named `apps`, installs Claude Desktop, and exports the
Signal and Claude launchers to the app grid. App data lives in your normal
home (`~/.config/Signal`, `~/.config/Claude`), so it survives recreating the
box.

### Automatic recreate

```sh
~/claude/appbox/host/install
```

That symlinks `host/appbox-update.{service,timer}` into
`~/.config/systemd/user/`, enables the timer, and prints the settings this
machine will use. It is safe to re-run. The service runs from
`~/claude/appbox` by default; if the checkout lives elsewhere, `host/install`
adds a systemd drop-in pointing at it.

The timer fires daily at 04:30 (after Aurora's own 04:00 `uupd` run). On a
laptop that is asleep at that hour, it fires as soon as the lid opens. Each run
of `host/appbox-update`:

1. Fast-forwards the repo checkout (`git pull --ff-only`) and, if that
   brought in changes, re-runs the new version of itself. See
   [Managing machines centrally](#managing-machines-centrally).
2. Does nothing unless the box is at least 7 days old (so recreates are
   weekly, and a skipped day is retried the next day).
3. Skips if Signal or Claude Desktop is running in the box, so an open
   session is never killed. If the box reaches twice its maximum age (14
   days by default) because the apps never quit (an always-on desktop), it
   sends a desktop notification asking you to quit them and run the update.
4. Waits up to 2 minutes for the network (it is often still coming up right
   after resume). If the network or pull fails, the service retries every
   2 minutes, up to 5 times an hour, like `uupd`.
5. Pulls and verifies the image signature, then recreates the box from that
   exact verified digest with `pull=false`. Nothing touches the network after
   the old box is deleted except the Claude Desktop install, and if that
   fails, the script retries it and re-exports the launcher.
6. Shows a notification while the box is rebuilt (about a minute; launchers
   do not work during that window) and when it is done, then deletes the
   previous image. The box is left stopped afterwards; the next launch starts
   it in about a second.

`cosign` is looked up on `PATH`, then at Homebrew's
`/home/linuxbrew/.linuxbrew/bin/cosign`.

Run it by hand with `systemctl --user start appbox-update`, or
`host/appbox-update --force` to skip the age check (the running-app check
still applies). `host/appbox-update --show-config` prints the settings in
effect without changing anything. Logs: `journalctl --user -u appbox-update`.

## Managing machines centrally

Everything a machine runs comes from this repo, so changes are made here and
pushed, not on the machines:

- **The image** is rebuilt daily by CI and picked up by each machine's next
  recreate.
- **The update script, units, and `distrobox.ini`** reach each machine on its
  next timer run, because the script fast-forwards its checkout first.
  A pull that fails (offline, local edits, diverged history) is logged and the
  run continues with what is checked out. Unit file changes take effect after
  `systemctl --user daemon-reload` (re-run `host/install`).
- **Per-machine settings** live in `hosts/<hostname>.env`, where `<hostname>`
  is `hostname -s`. Copy `hosts/example.env` to start one. Supported keys:
  `APPBOX_MAX_AGE_DAYS`, `APPBOX_INI` (to give a machine its own ini, for
  example `hosts/<hostname>.ini` with extra apps), and `APPBOX_SELF_UPDATE`
  (set `0` on a checkout you develop in). The file is parsed as plain
  `KEY=VALUE`, never executed. A machine without a file uses the defaults.
- **Setup records** live next to the settings, in `hosts/<hostname>.md`: what
  the machine is, what was migrated, and anything specific to it.

Trust tradeoff: the image is signature-checked before use, but the script is
not. Each machine runs whatever is on `main` of this repo, so anyone who can
push to `main` can run code on every enrolled machine as your user. Keep `main`
protected accordingly.

Machines so far: [`aurora-think`](hosts/aurora-think.md) (laptop).

Open follow-ups (branch protection, signed commits, key backup, and more)
are tracked in [`docs/TODO.md`](docs/TODO.md).

## Adding an app

1. Install it in the image:
   - From Ubuntu's archive: add the package name to `packages/appbox.packages`.
   - From a vendor apt repo: add the key and source in `scripts/appbox.sh`,
     following the Signal block (check the key fingerprint with `fetch_key`),
     and add the package to the `apt-get install` line.
   - If its license does not allow redistribution, do not bake it in. Add the
     repo only and install it from an init hook, like `claude-desktop-sync`.
2. Find its real `.desktop` file: `distrobox enter apps -- dpkg -L <package> | grep '\.desktop$'`
3. Add that full path to `exported_apps` in `distrobox.ini`.
4. Push, wait for CI, then `distrobox assemble create --file distrobox.ini`.

## Ubuntu release upgrades (EOL)

`ubuntu-toolbox` only publishes `:latest`, so the Containerfile pins the
release with `ARG UBUNTU_VERSION`. If ublue moves `:latest` to a new release,
the build fails instead of shipping a surprise upgrade, and the old image
stays on ghcr. To upgrade:

1. Change `UBUNTU_VERSION` in `ContainerFiles/appbox` (for example `26.04` to `28.04`).
2. Push and let CI build. Package renames (the `t64` transition is a recent
   example) show up as `apt-get install` failures in the build log; fix
   `packages/appbox.packages` until it is green.
3. Recreate the box. App data lives in `~/.config`, so nothing is lost.

To roll back after a bad update, point `image=` in `distrobox.ini` at an older
dated tag and recreate.

## Verifying the image

```sh
cosign verify --key cosign.pub ghcr.io/danathar/appbox:latest
```

`cosign.pub` is in this repo. The private key is the `SIGNING_SECRET`
repository secret. CI also verifies its own signature after signing, and
verifies ublue's signature on the base image before building.
