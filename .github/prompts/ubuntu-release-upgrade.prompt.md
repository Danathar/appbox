---
description: Move the appbox image to a new Ubuntu LTS release after ublue moves ubuntu-toolbox:latest
---

`ghcr.io/ublue-os/ubuntu-toolbox` only publishes `:latest`, so
`ContainerFiles/appbox` pins the release with `ARG UBUNTU_VERSION` and the
build fails on purpose when `:latest` moves to another release. The old image
stays on ghcr, so machines keep working meanwhile. Move appbox to Ubuntu
`${input:version}` (follow the README section "Ubuntu release upgrades (EOL)"):

1. Confirm the cause first: read the failed run
   (`gh run list -R Danathar/appbox --workflow build-appbox`, then
   `gh run view <id> -R Danathar/appbox --log-failed`) and check that the
   failure is the `UBUNTU_VERSION` guard, not something else.
2. On a branch, change `UBUNTU_VERSION` in `ContainerFiles/appbox` to
   `${input:version}`. Change nothing else in the same commit.
3. Open a PR (`gh pr create -R Danathar/appbox --body-file ...`). CI builds the
   image. Package renames (the `t64` transition was a recent example) show up
   as `apt-get install` failures in the build log: fix
   `packages/appbox.packages` or the install line in `scripts/appbox.sh` until
   the build is green. Look up each replacement package for the new release;
   do not guess names.
4. Check the vendor repos against their current install instructions. Neither
   names an Ubuntu codename today (Signal's `.sources` file is downloaded from
   Signal; Claude Desktop uses the `stable` suite), but both vendors publish
   packages built against a set of Ubuntu libraries, so read the build log for
   dependency errors. Each `fetch_key` fingerprint stays as it is unless the
   vendor's own docs show a new one.
5. Check that every `.desktop` path in `exported_apps` (`distrobox.ini`,
   `hosts/*.ini`) still exists in the new image.

This is a Tier 2 change. In the PR state the machine impact: machines pick
up the new release at their next weekly recreate, app data in `~/.config`
survives, and the rollback is pointing `image=` at the last dated tag of the
old release. Do not recreate any box yourself; the owner does that.
