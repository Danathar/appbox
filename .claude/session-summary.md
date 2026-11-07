# Session summary

The handoff between working sessions. Read it at the start of a session,
after [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md). It carries only
what is true right now and would otherwise have to be rediscovered. Standing
rules belong in AGENTS.md, mistakes worth never repeating in
[memory/](memory/README.md), recurring patterns in
[../docs/reflections/](../docs/reflections/), and which issue became which PR
in [../docs/agent-tasks/](../docs/agent-tasks/README.md).

**Host rule.** `main` is live on every enrolled machine. Never run
`host/appbox-update` (other than `--show-config`) or `host/install`, never
remove, stop or recreate a box, never touch an open app. `guard-bash.mjs`
enforces it. GitHub commands pass `-R Danathar/appbox`.

## How to use it

Start of session:

1. Read "Current state" and the "Last session" entry below.
2. Check anything you are about to rely on. PR numbers, branches and SHAs
   drift: `git log origin/main`, `gh pr list -R Danathar/appbox`,
   `gh issue list -R Danathar/appbox`.

End of session. This file is one tracked file, so concurrent PRs that all
rewrite it conflict. Only the session that lands work on `main` (the one that
merges, or a handoff PR opened after the merge) rewrites it, starting from the
current `origin/main` copy. A session whose PR merges later puts its notes in
the PR body and leaves this file alone. When you do update it:

1. Make "Current state" match what is on `main` now.
2. Replace the "Last session" entry; do not append a history.
3. Rewrite "Open threads" and "Next steps": drop what is done, keep each item
   to one line with its issue or PR number.
4. Record only what you observed. Mark guesses as `[INFERENCE]`.

Entry format:

```markdown
## Last session: <YYYY-MM-DD> - <one-line focus>

**Done:** what landed, with PR and issue numbers
**In flight:** open PRs, unmerged branches, half-finished work
**Blocked on:** decisions or merges needed before the next step
**Watch:** observed but not acted on
```

---

## Current state (as of 2026-11-07)

Written by the ACMM agent-config PR (`acmm/agent-config`) before it merged;
the coordinator rewrites this once all ACMM PRs are in.

- **What the repo is:** the `ghcr.io/danathar/appbox` image (Ubuntu 26.04 via
  `ubuntu-toolbox:latest`, guarded by `UBUNTU_VERSION`; Signal baked in;
  Claude Desktop installed at box start) and `host/appbox-update` with its
  user timer. One enrolled machine so far: `aurora-think` (laptop,
  `hosts/aurora-think.md`). The desktop is not migrated yet (`docs/TODO.md`).
- **Script history:** `c5dbf7d` (self-update, per-machine settings,
  `host/install`), `5a4e4eb` (network wait, retry, digest-pinned recreate),
  `972558d` (closed apps upgraded daily, open apps never touched,
  install-only hook, `rebuild_skipped` flag). Dependency updates come from
  Renovate only (dashboard issue #8).
- **ACMM onboarding:** issues #16 to #59 and #63, split over six PRs plus the
  coordinator's README and ruleset work. Rows and PR numbers in
  [../docs/agent-tasks/2026-11-07.md](../docs/agent-tasks/2026-11-07.md).
- **Merging:** autonomous hive, no human-merge gate on any tier. The
  required check is CI's aggregate `test` job; Tier 2 changes get
  reviewer-agent review, tests and a stated machine impact. The owner's brake
  is the `hold` label.
- **Agent tooling:** `.claude/settings.json` denies secret reads and the most
  dangerous commands and runs `.claude/hooks/guard-bash.mjs` on every Bash
  call; its tests run with `node --test .claude/hooks/tests`.

## Last session: 2026-11-07 - ACMM onboarding

**Done:** agent configuration drafted (AGENTS.md, CLAUDE.md, Copilot and
Cursor rules, prompts, skills, memory, settings and guard hook, boundaries,
CODEOWNERS, task ledgers) on `acmm/agent-config`.
**In flight:** the six ACMM PRs and the coordinator's ruleset change.
**Blocked on:** merges.
**Watch:** `distrobox.ini` still says the init hook will "Install or upgrade
Claude Desktop on every box start", but `scripts/claude-desktop-sync` is
install-only since `972558d`. The comment is stale; the behaviour is right.

## Open threads

- `docs/TODO.md` holds the owner's follow-ups (signed commits, key backup,
  keyless signing, podman signature policy, smaller weekly download, CI smoke
  test, failure notification, desktop migration).
- The `hold` label did not exist when PR #60 was opened; it has to exist
  before the owner can use it as the brake.

## Next steps

1. Merge the ACMM PRs and fill in the PR and outcome columns of the
   2026-11-07 ledger.
2. Fix the stale `distrobox.ini` comment above (Tier 2, one line).
