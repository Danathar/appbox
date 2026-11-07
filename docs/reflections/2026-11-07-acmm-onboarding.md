# Onboarding appbox to the hive in one pass

**Date:** 2026-11-07
**Context:** the hive's ACMM evaluation opened issues #16 to #59 on this
repository, one per missing criterion. They were worked as six parallel pull
requests (tests and CI; contributor templates and labeler; agent config;
governance docs and policies, the branch `acmm/governance` that adds this
file; scheduled automation; AI and metrics workflows), with a file ownership
map so no two touched the same file. The owner paused the repository in the
hive while this ran, so no hive agent competed for the same issues. The
template was `Danathar/openaudible-autoupdate`, which went through the same
issue set in October and is at L6.

## What happened

- **The template's tiers assumed a human merge.** `Danathar/openaudible-autoupdate`'s
  `risk-config.json` gives its two riskiest tiers `"review": "owner"`. The
  first plan for this repository copied that shape, with Tier 2 waiting for
  the owner. Partway through, the owner corrected it: appbox runs on a fully
  autonomous hive and has no human merge gate on any tier. Tier 2 means the
  reviewer agent looks hardest and the pull request states its machine
  impact; the owner's brake is the `hold` label. [`risk-config.json`](../../risk-config.json)
  now has `"human_gate": false` and a `scrutiny` level per tier instead of a
  reviewer.
- **The policies became the gate, so they were rewritten to guard Tier 2.**
  With no reader before merge, `policies/image-safety.json` checks the
  invariants a person would otherwise check: no `claude-desktop` in the
  image, the build's verify, build, push, sign, verify order, the updater's
  verify-before-replace order, the init hook never upgrading and always
  exiting 0. `scripts/check-policies.mjs` also hard-codes a floor, so a pull
  request that only edits a policy JSON cannot switch those off.
- **The existing build workflow did not meet the new workflow rule.**
  `.github/workflows/build-appbox.yml` has no top-level `permissions:` block;
  its one job sets its own. The file is Tier 2 and out of scope for
  onboarding, so `policies/workflow-permissions.json` carries one documented
  exception, held to "every job declares permissions", instead of a change
  to the build.
- **actionlint is not clean on the build workflow.** Run locally, it reports
  shellcheck SC2086 (info) on the `run:` blocks of the "Sign container image"
  and "Verify signature" steps (unquoted `${{ ... }}` image references). Not
  fixed here, for the same reason.
- **A comment disagrees with the code it describes.** `distrobox.ini` says
  the init hook will "Install or upgrade Claude Desktop on every box start".
  `scripts/claude-desktop-sync` installs only and never upgrades, which is
  the rule in `CLAUDE.md`. Found while writing the init-hook policy; left for
  a Tier 2 pull request.
- **Tier numbers run the other way in the template.** There, Tier 1 is the
  most dangerous; here, Tier 2 is. The template's checker picks the lowest
  matching number; this one picks the highest.
- **Lessons carried over from the template's own reflection**
  (`Danathar/openaudible-autoupdate`, `docs/reflections/2026-10-09-acmm-lessons-from-tududi.md`):
  CI that pulls anonymously from Docker Hub failed every pull request at once
  on `Danathar/tududi#58`; a regex guard grown one bypass at a time took
  eight fix commits on `Danathar/tududi#53` until its threat model was
  written first; automated review ran out of quota mid-rollout on
  `Danathar/tududi#53` and `#60`. This repository's checker states its
  threat model in `policies/README.md` ("What the checker does not defend
  against") before its rules.

## What it shows

- A template is a structure to copy, not a set of facts. The facts that
  matter most (who merges, which way the tiers run, which files are live)
  differ between repositories with the same shape, and copying them is the
  easy mistake.
- Without a human merge, every invariant needs a mechanical owner: a policy,
  a test, or the e2e build. Writing the policies forced a list of what
  appbox's invariants actually are, and that list found the `distrobox.ini`
  comment and the build workflow's missing top-level permissions.
- [INFERENCE] Pre-existing Tier 2 files will keep collecting small findings
  during onboarding work that is not allowed to touch them. They need a
  follow-up pull request, not a note that is forgotten.

## What to do next time

- Before copying governance files from another repository, write down this
  repository's merge model (who merges, which check is required, what the
  brake is) and check every copied tier and rule against it.
- For each Tier 2 invariant, name the check that enforces it. If there is
  none, add a policy or a test in the same pull request, or record the gap in
  `docs/TODO.md`.
- Keep CI off anonymous Docker Hub pulls. The base image here comes from
  ghcr.io; tools in CI should too, or come from the runner image.
- Collect the findings in files that were out of scope (the three above) and
  open one follow-up pull request for them as soon as onboarding merges.
