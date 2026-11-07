---
name: add-an-app
description: Add a desktop app to the appbox image and the apps box (package list or vendor apt repo, launcher export, guarded_apps), following the README's "Adding an app" steps and the licensing rule.
---

# add-an-app

Follows "Adding an app" in `README.md`. Every step below touches Tier 2 paths,
so the PR needs tests where a script changes and a stated machine impact.
It is two pull requests, because the image change must be built green before
the ini change that exports the launcher.

## 1. Decide where the app comes from

- **Ubuntu archive:** add the package name to `packages/appbox.packages`.
- **Vendor apt repo, licence allows redistribution:** add the key and source
  in `scripts/appbox.sh` following the Signal block. Pin the key's
  fingerprint with `fetch_key URL FINGERPRINT FILE`, and take both the
  fingerprint and the repo line from the vendor's current install
  instructions, not memory. Add the package to the `apt-get install` line.
- **Proprietary:** never bake it into the image (the image is public). Add the
  vendor repo only, and install it from an install-only init hook modelled on
  `scripts/claude-desktop-sync`: it installs when missing, never upgrades, and
  always exits 0.
- Signal's repo is amd64 only, so the image is amd64 only; check the new
  app's architectures.

## 2. First PR: the image

Open the PR with the change from step 1. State the machine impact: every
machine gets the package at its next weekly recreate; nothing is exported
yet. Wait until it is merged and the `build-appbox` run on `main` is green
and signed (`gh run list -R Danathar/appbox --workflow build-appbox`).

## 3. Find the real launcher

Get the `.desktop` path from the built image, never by guessing. In a
throwaway container of the new image:
`podman run --rm ghcr.io/danathar/appbox:latest dpkg -L <package> | grep '\.desktop$'`.
(`distrobox enter apps -- dpkg -L <package>` works too once the owner's box
has been recreated; it only reads.) A proprietary app installed at box start
is not in the image, so take its path from the vendor package's file list
instead and say so in the PR.

## 4. Second PR: export and guard

- Add the full path to `exported_apps` in `distrobox.ini` (or only in
  `hosts/<hostname>.ini` if just one machine wants it). Keep the shared ini
  GPU-neutral.
- If the app should block rebuilds while open and be upgraded in place
  between rebuilds, add it to `guarded_apps` in `host/appbox-update` (the name
  must be both the package name and the process name as `pgrep -x` sees it)
  and give it a friendly name in `app_label`. Add bats cases for the new
  entry in `tests/unit`. Otherwise it only updates with the weekly rebuild,
  which will close it if it is open; say that in the PR.
- Machine impact: launchers appear after each machine's next recreate.

Never run `distrobox assemble create` or `host/appbox-update` yourself; the
owner recreates boxes.
