# Copilot instructions

The full rules are in [AGENTS.md](../AGENTS.md); read it before changing
anything. appbox is a CI-built, cosign-signed distrobox image
(`ghcr.io/danathar/appbox`, Ubuntu LTS, Signal baked in, Claude Desktop
installed at box start) plus `host/appbox-update`, a systemd user timer script
that keeps each machine's `apps` box current. The top rules:

1. **`main` is live.** Every enrolled machine fast-forwards to `main` and runs
   it. Never force-push, rewrite or push directly to `main`; open a pull
   request from a branch.
2. **Never bake a proprietary app (Claude Desktop) into the image.** It is
   public. Add the vendor repo and install from an install-only init hook
   that always exits 0, like `scripts/claude-desktop-sync`.
3. **An open app is never touched.** Upgrades happen only in
   `host/appbox-update`, only for closed apps in `guarded_apps`.
4. **Never run `host/appbox-update` or `host/install` on a real machine**
   (`--show-config` is the one safe run). Test with `bats tests/unit` and
   `tests/e2e/`. Never call a function that must abort under errexit as
   `func && ...` or `if func`.
5. **State the machine impact in every PR:** an image change must be green
   before an ini change that depends on it, and unit file changes need
   `systemctl --user daemon-reload` on each machine.

Also: sign off commits (`git commit -s`), pass `-R Danathar/appbox` to every
`gh` command, never read secrets, never layer packages with rpm-ostree, and
write no em dashes. Changes to `host/`, `hosts/`, `distrobox.ini`, the image
files and the build workflow are Tier 2: they merge on green checks like
everything else, but need reviewer-agent review, tests and a stated machine
impact ([docs/risk-tiers.md](../docs/risk-tiers.md)).
