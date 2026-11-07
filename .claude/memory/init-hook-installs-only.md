# The box-start hook installs only; Claude Desktop is never baked in

**Date:** 2026-11-07
**Wrong:** the first `scripts/claude-desktop-sync` installed Claude Desktop on
a new box and, on every later start, upgraded it in the background. A box
usually starts because an app was just clicked, so the upgrade replaced files
under an app that was starting. The tempting "simpler" fix, installing Claude
Desktop in the image, is not allowed at all: the image is public and the
package is proprietary.
**Right:** the image carries only Anthropic's apt key and source; the hook
installs the package when it is missing and otherwise exits immediately. It
never upgrades and always exits 0 (`distrobox-init` runs with `errexit`, so a
failing hook stops the box and every app in it). Upgrades happen in
`host/appbox-update`, only while the app is closed. `scripts/appbox.sh` ends
with a check that fails the build if `claude-desktop` is installed in the
image.
**Why it matters:** an upgrade under a starting app can break it; a failing
hook takes Signal down too; a baked proprietary package would be
redistributed to anyone who pulls `ghcr.io/danathar/appbox`.
**Evidence:** `git show 7cbec40:scripts/claude-desktop-sync` (the old
"Later starts: upgrade in the background"); commit `972558d` ("The box-start
hook is install-only. Upgrading there replaced files under an app that was
just clicked."); `git show 3f0a896:scripts/claude-desktop-sync`;
`scripts/appbox.sh` ("claude-desktop must not be installed in the image");
`README.md`, "What is baked in vs installed at box start".
