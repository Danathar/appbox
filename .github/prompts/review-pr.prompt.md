---
description: Review an appbox pull request against the repo's rules and its machine impact
---

Review PR `${input:pr}` with `gh pr view ${input:pr} -R Danathar/appbox` and
`gh pr diff ${input:pr} -R Danathar/appbox`. Use the rubric in
`docs/review-rubric.md` and the tiers in `docs/risk-tiers.md`. Do not push to
the PR's branch, approve or merge it. Cite `file:line` for every finding.

1. **Tier.** The highest tier any touched path matches. Tier 2 (anything
   machines run or the image contains, plus `.claude/settings.json` and
   `.claude/hooks/`) needs tests covering the change and a stated machine
   impact.
2. **Machine impact.** Is it stated and right? What a merge deploys, and
   when (see the table in `docs/working-on-the-repo.md`). Unit file changes
   say `systemctl --user daemon-reload` is needed. An ini change that needs
   something new in the image is not merged before the image change is built
   green.
3. **Open apps.** Nothing rebuilds or upgrades an app that is running. New
   upgrade logic lives in `host/appbox-update` behind the running-app check;
   init hooks install only and always exit 0.
4. **Licensing.** No proprietary package is baked into the image; the
   `claude-desktop must not be installed in the image` guard at the end of
   `scripts/appbox.sh` stays.
5. **errexit.** No `func && ...` or `if func` for a function that must abort
   on failure (see `rebuild_box` and `rebuild_skipped`). `set -euo pipefail`
   stays.
6. **Verification.** Signature checks (base image, appbox image) and
   `fetch_key` fingerprints are not removed or softened.
7. **Tests and checks.** shellcheck clean; a bats test covers each behaviour
   change; CI green.
8. **Hygiene.** No em dashes, DCO sign-off on every commit, docs match the
   code, unrelated changes disclosed.

Output: a verdict (looks good / changes needed), findings by severity, and
the checks you ran.
