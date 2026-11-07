# Strategy

Why appbox exists, what it is trying to achieve, what it deliberately does
not do, and what comes next. Rules for agents are in `AGENTS.md`; how agents
share the repository is in [multi-agent.md](multi-agent.md); the open work
list is [TODO.md](TODO.md).

## Why it exists

The owner runs desktop apps (Signal and Claude Desktop today) on atomic
Fedora hosts (Aurora), where apps that are not Flatpaks live in distrobox
containers. A hand-maintained box drifts, needs manual upgrades, and is lost
work when it breaks. appbox replaces it with:

- a **CI-built image**, `ghcr.io/danathar/appbox`, on top of ublue's signed
  `ubuntu-toolbox`, rebuilt daily and cosign-signed;
- a **host timer**, `host/appbox-update`, that keeps each machine's `apps`
  box current without the user doing anything, and without ever touching an
  app that is open;
- **one repository for every machine**, so changes are made once and pushed,
  not repeated on each host. Per-machine differences live in `hosts/`.

## Goals

| Goal                                   | What it means                                                                                                                                                   | How it is checked                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Reliable unattended updates            | Every enrolled machine stays current with no manual step: weekly rebuild from a verified image, daily in-place upgrades of closed apps, self-update from `main` | bats tests of `host/appbox-update`, the e2e image build, the policy sequences for verify-before-replace; each machine's journal |
| Never interrupt an open app            | No rebuild and no upgrade while a guarded app is running; init hooks install only                                                                               | the `app_running_in_box` checks (tests and `policies/image-safety.json`), the init-hook policy                                  |
| The public image stays redistributable | Only apps whose licence allows redistribution are baked in; proprietary apps are installed at box start                                                         | `policies/image-safety.json`, and the build's own `dpkg-query` check                                                            |
| The image is trustworthy               | Built only on a signed base, signed itself, verified by every machine before use                                                                                | the `build-signing` and `host-rebuild` policy sequences; `cosign verify --key cosign.pub ghcr.io/danathar/appbox:latest`        |
| More apps, more machines               | Adding an app is a documented, repeatable change (README, "Adding an app"); a new machine follows `docs/install.md`                                             | `hosts/*.md` records; the e2e image build                                                                                       |
| Safe autonomous maintenance            | Hive agents maintain the repository with no human merge gate, so the mechanical checks carry the safety                                                         | [quality.md](quality.md), [metrics.md](metrics.md), the agent audit                                                             |

None of these is a speed target. A faster update that once replaces files
under a running Signal is a failure.

## What it will not do

- Bake a proprietary app into the public image.
- Touch an app that is open, to save a day on an update.
- Skip or soften a signature check (base image, built image, or on the
  machine) to make something work.
- Rewrite `main`. Every machine would silently stop updating.
- Layer packages on the host with rpm-ostree.
- Grow into a general distrobox manager. It manages one box per machine
  (`apps`), defined by an ini in this repository.

## Constraints

- **amd64 only, for now.** Signal's official apt repository is amd64 only.
  Claude Desktop's repository has arm64, so an arm64 image is blocked on
  Signal: it would need a different source (Flatpak or AppImage) on arm64
  hosts, which changes how Signal is updated and guarded.
- **Ubuntu release pinned.** `ubuntu-toolbox` only publishes `:latest`, so
  `UBUNTU_VERSION` in the Containerfile turns a release change into a
  deliberate one-line upgrade rather than a surprise.
- **One gap remains in "never interrupt".** An app clicked in the second
  between the last check and the box being deleted, or during the minute of
  the rebuild, fails to start or is cut short (README, "How updates reach
  you"). The notification marks the window; app data is safe either way.

## Current priorities

From [TODO.md](TODO.md), roughly in order:

1. **Protect `main`.** A ruleset that blocks force pushes and deletion and
   requires `test`. With no human merge gate, this is what makes the checks
   binding.
2. **Signed commits, verified by the updater.** So a stolen token cannot put
   code on every machine. The allowed-signers file must live outside the
   repository.
3. **Back up the cosign key, or move to keyless signing** with the
   workflow's OIDC identity, which removes the key altogether.
4. **Make podman enforce the signature**, so a manual
   `distrobox assemble create` is checked too.
5. **Smoke-test the image in CI before pushing**: launchers exist, Signal
   starts, Claude Desktop still installs in a throwaway container.
6. **Notify on update failure** with an `OnFailure=` unit.
7. **Shrink the weekly download** by splitting layers or using
   `zstd:chunked`.
8. **Roll out to the desktop**, and see whether the 14-day notification
   becomes routine on a machine where Signal never quits.

## Keeping this page honest

Do not put a number here that a later commit can make false. Priorities
follow `docs/TODO.md`; when an item there is done, update the list here in
the same pull request.
