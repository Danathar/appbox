# appbox

[![CI](https://github.com/Danathar/appbox/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Danathar/appbox/actions/workflows/ci.yml)
[![Build image](https://github.com/Danathar/appbox/actions/workflows/build-appbox.yml/badge.svg?branch=main)](https://github.com/Danathar/appbox/actions/workflows/build-appbox.yml)
[![Coverage gate](https://github.com/Danathar/appbox/actions/workflows/coverage-gate.yml/badge.svg?branch=main)](https://github.com/Danathar/appbox/actions/workflows/coverage-gate.yml)
[![Nightly compliance](https://github.com/Danathar/appbox/actions/workflows/nightly-compliance.yml/badge.svg?branch=main)](https://github.com/Danathar/appbox/actions/workflows/nightly-compliance.yml)
[![Ask DeepWiki](https://img.shields.io/badge/Ask-DeepWiki-1f6feb)](https://deepwiki.com/Danathar/appbox)
[![Maintenance assisted by Hivecommons Hive](https://img.shields.io/badge/maintenance%20assisted%20by-Hivecommons%20Hive-1f6feb)](https://github.com/hivecommons/hive)
[![ACMM L6 Fully Autonomous](https://img.shields.io/badge/ACMM-L6%20Fully%20Autonomous-2da44e)](#maintained-with-hive-acmm-l6)
[![AI assisted](https://img.shields.io/badge/AI-assisted-d29922)](#about-this-project)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> [!NOTE]
> This was created with AI assistance and should be treated cautiously. The
> update timer deletes and recreates a distrobox and runs whatever is on `main`
> as your user, so read `host/appbox-update` before you install it. See
> [About this project](#about-this-project).

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
| Signal Desktop | Baked into the image | AGPL-3.0, fine to redistribute. Launches immediately after a rebuild. |
| Claude Desktop | Installed by `init_hooks` on the first start of a new box | Proprietary. The public image only carries Anthropic's apt key and source, never the package. |

The image does pre-install Claude Desktop's dependencies (all from the Ubuntu
archive, including the qemu/OVMF/virtiofsd stack Cowork uses), so the
box-start install only downloads the app itself (about 25 seconds). It runs
synchronously so the launcher can be exported, and logs to
`/var/log/appbox-claude-sync.log` inside the box. On every later start the
hook sees Claude is installed and exits immediately: it never upgrades,
because a box usually starts because an app was just clicked, and replacing
files under a starting app is unsafe. Upgrades come from the host timer
instead (see [How updates reach you](#how-updates-reach-you)). The hook always
exits 0, because a failing init hook would stop the box (and Signal) from
starting, for example when booting offline.

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

## How updates reach you

**The rule: an app that is open is never touched.** Not rebuilt, not
upgraded. Updates wait until you quit it (tray > Quit; closing the window
leaves it running in the tray, which counts as open). Signal and Claude are
the "guarded apps", listed in `guarded_apps` at the top of
`host/appbox-update`.

The timer fires daily at 04:30 (after Aurora's own 04:00 `uupd` run). On a
laptop that is asleep at that hour, it fires as soon as the lid opens. Each run
of `host/appbox-update`:

1. **Self-updates:** fast-forwards the repo checkout and, if that brought in
   changes, re-runs the new version of itself. See
   [Managing machines centrally](#managing-machines-centrally).
2. **Weekly rebuild:** once the box is at least 7 days old, rebuilds it from
   the latest signed image, unless a guarded app is open. A skipped rebuild is
   retried the next day. A fresh box already has the newest apps, so a run
   that rebuilds stops here.
3. **Daily in-place upgrades:** otherwise (box not due yet, or the rebuild
   was skipped), checks Signal and Claude inside the box for newer versions,
   upgrades each one that is closed, and leaves each one that is open alone.

| Situation | What happens | Notification |
| --- | --- | --- |
| New Signal or Claude version, app closed | Upgraded in place on the daily run | None (see the journal) |
| New version, app open | Left alone; installed on the first daily run after you quit it | "Signal 8.x is ready" / "Claude 4.x is ready", once per new version |
| Box is 7+ days old, an app is open | Rebuild skipped, retried daily | "Weekly apps update is waiting", once |
| Box is 14+ days old, an app is open | Rebuild still skipped | "apps box is N days old", on every skipped run |
| Rebuild starts / finishes | Box rebuilt (about a minute; launchers do not work meanwhile) | "Updating the apps box", then "apps box updated" |
| Rebuild finished but a launcher is missing | Claude install retried, launcher re-exported | Critical notification pointing at the journal |

**To apply an update right away:** quit the app (tray > Quit), then run
`systemctl --user start appbox-update`. That runs the same daily logic now: it
upgrades the closed apps, or does the rebuild if one is due.
`host/appbox-update --force` rebuilds now regardless of the box's age; it
still refuses while a guarded app is open.

The one gap: if you click an app in the second or two between the final
"is it open?" check and the box being deleted, or during the minute the
rebuild takes, that launch fails or is cut short. The "Updating the apps box"
notification marks that window. App data lives in `~/.config` on the host, so
nothing is lost either way.

Rebuild details: the script waits up to 2 minutes for the network (it is
often still coming up right after resume), and if the network or pull fails
the service retries every 2 minutes, up to 5 times an hour, like `uupd`. It
pulls and verifies the image signature, then recreates the box from that
exact verified digest with `pull=false`, so nothing touches the network after
the old box is deleted except the Claude Desktop install (retried, with the
launcher re-exported, if it fails). It then deletes the previous image. The
box is left stopped afterwards; the next launch starts it in about a second.

Other details:

- Notification state (which versions you were told about, whether this box
  was nudged) lives in `~/.local/state/appbox/` and is cleared by a rebuild.
- `cosign` is looked up on `PATH`, then at Homebrew's
  `/home/linuxbrew/.linuxbrew/bin/cosign`.
- `host/appbox-update --show-config` prints the settings in effect without
  changing anything. Logs: `journalctl --user -u appbox-update`.

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
     repo only and install it from an install-only init hook, like
     `claude-desktop-sync` (never upgrade from a hook; see
     [How updates reach you](#how-updates-reach-you)).
2. Push, and wait for CI to go green before the next steps.
3. Find its real `.desktop` file: `distrobox enter apps -- dpkg -L <package> | grep '\.desktop$'`
4. Add that full path to `exported_apps` in `distrobox.ini`.
5. If it should be protected from rebuilds while open and upgraded in place
   between rebuilds, add it to `guarded_apps` in `host/appbox-update` (the
   name must be both its package name and its process name as `pgrep -x`
   sees it), and give it a friendly name in `app_label`. Otherwise it only
   updates with the weekly rebuild, which will close it if it is open.
6. Push, then `distrobox assemble create --file distrobox.ini`.

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

## Feedback and contributing

Bugs and rough edges are welcome: [open an issue](https://github.com/Danathar/appbox/issues).
To change something yourself, read [CONTRIBUTING.md](CONTRIBUTING.md) first; AI
agents start at [AGENTS.md](AGENTS.md). Found a security problem? Don't open a
public issue; report it privately through the repository's Security tab.

## Maintained with Hive (ACMM L6)

Maintenance is assisted by [Hivecommons Hive](https://github.com/hivecommons/hive),
which runs a fleet of AI agents against this repo at ACMM level 6 (Fully
Autonomous). The repository is maintained by [@Danathar](https://github.com/Danathar).

**What L6 permits here:** this is a fully autonomous hive. Agents file issues
and open pull requests, and every agent pull request merges once its required
checks pass, unless it carries `hold`. Hive merges them one at a time through
its serialized merge lane. No pull request waits for a person to merge it,
including Tier 2 changes to what machines run or what the image contains
(`host/`, `hosts/`, `distrobox.ini`, the image definition and build, the
signing keys) and to the agent boundary. Those get more scrutiny instead: the
reviewer agent reviews them, the tests and policy checks guard their
invariants, and the pull request states what a machine needs to do (such as a
`daemon-reload`). Because `main` reaches every enrolled machine, those checks
are the real gate. `main` is protected by a ruleset. The reviewer agent
comments with file and line references but never approves, merges or closes
anything. The owner's brakes are the `hold` label and pausing the repo in Hive.

See [`docs/branch-protection.md`](docs/branch-protection.md) for the required
checks, [`docs/risk-tiers.md`](docs/risk-tiers.md) for which changes get the most
scrutiny, [`docs/multi-agent.md`](docs/multi-agent.md) for how agents share the
repo and [`docs/agent-boundaries.md`](docs/agent-boundaries.md) for what agents
must never do.

Learn more: [Hive](https://github.com/hivecommons/hive) · [Hive Hub](https://hive.kubestellar.io) · [ACMM levels](https://github.com/hivecommons/hive#acmm-levels) · [full ACMM policy matrix](https://github.com/hivecommons/hive/blob/v4/src/docs/acmm-policy-matrix.md)

## About this project

> [!NOTE]
> This project was developed with AI assistance and should be treated
> cautiously.
>
> It is a personal, third-party setup. It is not affiliated with or endorsed
> by Signal, Anthropic, Universal Blue, or the distrobox project. Signal
> Desktop and Claude Desktop come from their vendors' own apt repositories;
> this repo only packages the box they run in.
>
> It comes as-is, with no promise that it is safe for your machines or data.
> The update timer deletes and recreates the `apps` box, upgrades apps inside
> it, and runs whatever is on `main` of this repository as your user. Read
> `host/appbox-update` and the systemd units before you install them. App data
> lives in your home directory and is not removed by a rebuild, but keep
> backups. The maintainer is not responsible for data loss, broken boxes, or
> other consequences of using it.

## License

Apache-2.0, see [LICENSE](LICENSE).
