# Agent boundaries

What an AI agent may change on its own in appbox, what needs more care, and
what it never does. It applies the tiers in [risk-tiers.md](risk-tiers.md)
and complements [AGENTS.md](../AGENTS.md) and the
[AI security policy](security/SECURITY-AI.md). Agents work on
`Danathar/appbox` only (`-R Danathar/appbox` on every `gh` command).

## No human-merge gate

appbox runs on a fully autonomous hive. **No tier needs a person to merge.**
An agent pull request merges once the required checks pass (CI's aggregate
`test` job), Tier 2 included. The tiers decide how much scrutiny a change
gets before that, not who clicks merge. The owner's brake is the `hold`
label: a pull request with `hold` does not merge until the owner removes it,
and an agent never removes it.

## By tier

| Tier                  | Paths                                                                                    | An agent may                                                                             | Before it merges                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, docs and tests     | Docs, tests, `.claude/memory/`, `docs/reflections/`                                      | Change them as part of any task.                                                         | Green required checks. A docs change must not hide a change to something machines run.                                                                   |
| 1, CI and tooling     | `.github/workflows/` (not the build), `scripts/*.mjs`, `policies/`, `.claude/` config    | Change them for the task at hand.                                                        | Green checks, and tests for any tooling change. Workflows keep `permissions: {}` at the top and SHA-pinned actions.                                      |
| 2, machines and image | `host/`, `hosts/`, `distrobox.ini`, image files, build workflow, Bash guard and settings | Change them when the task needs it, in a PR of their own that states its machine impact. | Reviewer-agent review, tests that cover the change, and a correct machine impact: what reaches machines and when, daemon-reload, image-before-ini order. |

Image files are `ContainerFiles/`, `scripts/appbox.sh`,
`scripts/claude-desktop-sync`, `packages/`, `keys/` and `cosign.pub`. The build
workflow is `.github/workflows/build-appbox.yml`. The Bash guard and settings
are `.claude/settings.json` and `.claude/hooks/**`: they are the boundary
this page describes, so a change that loosens them gets Tier 2 scrutiny even
though they live under `.claude/`.

The highest tier any touched path matches applies to the whole pull request.
Split unrelated Tier 2 work from Tier 0 or 1 work, so a reviewer sees the
machine-facing change on its own.

## Who owns what

`.github/CODEOWNERS` names `@Danathar` for everything (`*`) and lists the
Tier 2 paths again, so they are easy to find and GitHub shows the owner as
code owner on those files. The branch ruleset does not require code-owner
review, so CODEOWNERS is for visibility, not a merge gate. Keep its Tier 2
list in step with [risk-tiers.md](risk-tiers.md).

## Never, whatever the tier

These protect the machines, not the merge, so they hold for every agent in
every session. `.claude/settings.json` and `.claude/hooks/guard-bash.mjs`
enforce most of them for Claude Code; other agents follow them as written.

- Rewriting or force-pushing `main`, or pushing to `main` without a pull
  request. `main` is live on every enrolled machine.
- Baking a proprietary app into the image.
- Changing anything so that an open app is rebuilt or upgraded, or making an
  init hook upgrade or exit non-zero.
- Running `host/appbox-update` (other than `--show-config`) or `host/install`
  on a real machine, recreating, stopping or removing a box, or starting,
  stopping, enabling or reloading the appbox units. Real-machine tests are the
  owner's (see [working-on-the-repo.md](working-on-the-repo.md)).
- Installing anything on a host, or layering packages with rpm-ostree.
- Reading secrets: `.env`, `cosign.key` and other private keys, `~/.ssh`,
  `~/.config/gh`, `~/.config/appbox-signing`, tokens.
- Changing repository settings, rulesets, labels, secrets or branch
  protection; approving or merging pull requests; removing `hold`.
- Posting anywhere other than `Danathar/appbox`.
