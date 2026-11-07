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
| `host/` | systemd user timer and script that recreate the box from the fresh image. |

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

Works as-is on Intel and AMD GPUs (Mesa is in the base image). On an NVIDIA
host, add `nvidia=true` to `distrobox.ini`.

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
mkdir -p ~/.config/systemd/user
ln -sf ~/claude/appbox/host/appbox-update.service ~/.config/systemd/user/
ln -sf ~/claude/appbox/host/appbox-update.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now appbox-update.timer
```

The timer runs daily. `host/appbox-update` recreates the box only when it is
at least 7 days old, and skips if Signal or Claude Desktop is running in it, so
an open session is never killed and a skipped day is retried the next day. It
pulls and verifies the image signature before touching the box, so a failed
pull leaves the existing box in place. The service expects the checkout at
`~/claude/appbox`; edit `ExecStart` if yours lives elsewhere.

Run it by hand with `systemctl --user start appbox-update`, or
`host/appbox-update --force` to skip the age check. Logs:
`journalctl --user -u appbox-update`.

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
