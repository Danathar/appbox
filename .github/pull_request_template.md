## Summary

<!-- What changed and why, in plain sentences. Link the issue with "Fixes #N". -->

## Risk tier and paths

<!-- Tick the highest tier you touched. The tiers are in CONTRIBUTING.md and docs/risk-tiers.md. -->

- [ ] Tier 0: docs, tests, `.claude/memory/`, `docs/reflections/`
- [ ] Tier 1: CI and tooling (`.github/workflows/` other than the build, `scripts/*.mjs`, `policies/`, `.claude/` config)
- [ ] Tier 2: `host/`, `hosts/`, `distrobox.ini`, `ContainerFiles/`, `scripts/appbox.sh`, `scripts/claude-desktop-sync`, `packages/`, `keys/`, `cosign.pub`, `.github/workflows/build-appbox.yml`, `.claude/settings.json`, `.claude/hooks/`

## Machine impact

<!-- main is live: every enrolled machine runs it on its next timer run. Required for Tier 2. -->

- [ ] None (docs, tests, or CI only)
- [ ] Unit file changed (`host/*.service`, `host/*.timer`): each machine needs `systemctl --user daemon-reload` (or a re-run of `host/install`)
- [ ] Image change: the new image reaches machines at their next weekly recreate
- [ ] ini change that depends on the image: the image change is already merged and its `build-appbox` run on `main` is green (link it)

## Checks run

<!-- Paste the exact commands and what they printed. Untick what you did not run and say why. -->

- [ ] shellcheck on the shell scripts I touched (command in CONTRIBUTING.md)
- [ ] `bats tests/unit`
- [ ] `node --test scripts/tests .claude/hooks/tests`
- [ ] Image change: built it (`tests/e2e/`, or `podman build -f ContainerFiles/appbox -t localhost/appbox:test .`)
- [ ] Added or updated a test for each behaviour change
- [ ] README or `docs/` updated if behaviour or configuration changed

## Safety

- [ ] No proprietary app (Claude Desktop or any other) is baked into the image
- [ ] Nothing here upgrades or rebuilds while a guarded app is open; init hooks still install only and exit 0
- [ ] I did not run `host/appbox-update` against a real `apps` box with Signal or Claude open
- [ ] No em dashes in the files, commit messages, or this description
- [ ] Every commit is signed off (`git commit -s`)

## Not verified

<!-- Anything you could not test, for example a real recreate on an enrolled machine. -->

## AI assistance

- [ ] This PR was prepared with AI assistance (name the tool), or
- [ ] No AI assistance was used
