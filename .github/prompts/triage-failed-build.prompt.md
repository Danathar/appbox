---
description: Find out why a build-appbox run failed and propose the smallest fix
---

The `build-appbox` workflow (`.github/workflows/build-appbox.yml`) failed:
run `${input:run}` (an id or URL; if empty, take the latest failed run from
`gh run list -R Danathar/appbox --workflow build-appbox --status failure`).
The image is rebuilt daily from moving parts (the ublue base, the Ubuntu
archive, Signal's and Anthropic's apt repos), so a red nightly run often has
nothing to do with the last commit. Machines are not affected until a build
succeeds: the old image stays on ghcr.

1. Read the failure: `gh run view <id> -R Danathar/appbox --log-failed`.
   Name the failing step.
2. Classify it, citing the log lines:
   - **Verify base image signature:** ublue's signature on the base did not
     verify. Do not bypass or weaken the check. Report it; it may be an
     upstream key rotation (`keys/ublue-os-toolboxes.pub`) or a bad base.
   - **Build Image, `UBUNTU_VERSION` guard:** ublue moved `:latest` to a new
     release. Use `ubuntu-release-upgrade.prompt.md`.
   - **Build Image, `fetch_key` fingerprint mismatch:** a vendor rotated its
     key. Confirm the new fingerprint from the vendor's own current docs
     before changing the pin, and say where you confirmed it.
   - **Build Image, apt failure:** a package was renamed or removed, or a
     vendor repo was down. Re-run once (`gh run rerun <id> -R Danathar/appbox
     --failed`) if it looks transient; otherwise fix `packages/appbox.packages`
     or `scripts/appbox.sh`.
   - **Install cosign, Push To GHCR, Sign, Verify signature:** usually an
     outage (a sigstore Rekor outage once held CI for hours) or a secret
     problem. Report; never print or change `SIGNING_SECRET`.
3. If a fix is needed, open one PR on a branch with the smallest change, the
   failing and passing run links, and the machine impact. Never bake a
   proprietary package into the image to get a build green.

Report: the failing step, the cause, whether it is transient or needs a
change, and what you did.
