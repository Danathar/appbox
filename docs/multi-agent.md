# How several agents share this repository

More than one AI agent works on `Danathar/appbox`, next to its owner. This
page says who they are, how work reaches them, what keeps them from
colliding, and what decides that a change lands. `AGENTS.md` is the brief
every agent reads first and wins on any disagreement; `CLAUDE.md` and the
README describe the code.

It holds no counts, because they go stale. Every `gh` command here passes
`-R Danathar/appbox`.

## Rule 1: `main` is live

Every enrolled machine fast-forwards to `main` on its next timer run and
runs `host/appbox-update` from it. And there is no human merge gate: a pull
request merges once the required check `test` passes, on every tier
([risk tiers](risk-tiers.md)). Together that means an agent's merged change
runs on the owner's machines, unread, by the next morning. Every rule below
follows from that.

## There is no dispatcher in this repository

Nothing here decides which agent runs, when, or on what. The
[hive](https://github.com/hivecommons/hive) does that from outside, through a
GitHub App, and its dashboard is not part of this repository. Workflows in
`.github/workflows/` react to GitHub events (a push, a pull request, a label,
a comment, a schedule); they do not schedule agents. What each one is for is
in the [runbook](ai-ops-runbook.md#workflows).

## Who works here

| Who                  | How to recognise it                                                                                              | What it does                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| The owner (Danathar) | commits and pull requests under that login                                                                       | sets direction, holds or pauses, rotates keys, enrolls machines |
| Hive agents          | the GitHub App `danathar-atomic-hive` (`app/danathar-atomic-hive` in `gh`); bodies end with `hive: agent=<name>` | file issues, claim them, open pull requests, review, merge      |
| Codex connector      | review comments from `chatgpt-codex-connector[bot]` with `P0`-`P3` badges                                        | reviews pull requests; advisory, and may not post at all        |
| Workflow agents      | `ai-fix.yml` and `claude.yml` runs                                                                               | act on a request on one issue or pull request                   |
| Local agents         | Claude Code sessions on the owner's machines, committing as the owner                                            | work one issue on one branch, as the owner directs              |
| Renovate             | pull requests from Renovate                                                                                      | dependency updates, including action SHAs in workflows          |

Match the hive login exactly, not "any bot": `github-actions[bot]` also acts
here.

```sh
gh pr list -R Danathar/appbox --state all --author app/danathar-atomic-hive --json number,title,headRefName
gh api repos/Danathar/appbox/pulls/<N>/comments --jq '.[] | select(.user.login == "chatgpt-codex-connector[bot]") | .body'
```

## How work reaches an agent

- **An issue.** The hive reads open issues and files its own (the ACMM
  issues are titled `[ACMM L<n>]`).
- **A label or comment** that a workflow reacts to (`ai-fix.yml`,
  `claude.yml`); each file's header says who may trigger it.
- **The hive's schedule**, outside this repository. While the repository is
  paused in the hive, its agents leave it alone. It was paused for the ACMM
  onboarding and stays paused until that work has merged.

## What keeps agents from colliding

1. **Claim before you start.** The hive claims an issue for one agent; a
   local session checks for an open pull request or branch that already
   answers the issue before starting:

   ```sh
   gh pr list -R Danathar/appbox --state open --json number,title,headRefName
   gh issue view <N> -R Danathar/appbox --comments
   ```

   If another agent holds the issue, do not start a second branch for it.
2. **One pull request per issue** (or one named group of issues), with a
   `Fixes #N` line for each issue it closes. Branch from current
   `origin/main`; do not stack branches. Parallel local sessions use one
   clone or worktree each.
3. **Never push to a branch you did not create.** Comment instead.
4. **Shared files change only on purpose.** Conflicts here concentrate in a
   few files, and most of them are Tier 2:
   - **`host/appbox-update`** is what every machine runs. Only one open pull
     request at a time should change its logic; a second waits or rebases.
   - **`distrobox.ini`** and **`scripts/appbox.sh`** change together when an
     app is added, but in two pull requests: the image change first, merged
     and built green, then the ini change. A machine that recreates with the
     new ini and the old image fails to export the launcher.
   - **`host/*.service`, `host/*.timer`** change only in a pull request that
     exists to change them, and say that machines need a daemon-reload.
   - **`README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/ci.yml`**
     steer every other agent and every merge; change them in a pull request
     about that change.
5. **Rebase, do not merge `main` into your branch.** Then re-run what
   matters for your change.

## What decides that a change lands

- **The required check.** `test` (the aggregate job in `ci.yml`) must pass.
  It covers shellcheck, the bats tests, the node tests (including the policy
  check over the whole tree) and the e2e image build. The branch ruleset
  that makes it required is set up by the owner; see
  `docs/branch-protection.md` and [TODO](TODO.md).
- **The serialized merge lane.** The hive merges one pull request at a time,
  each brought up to date with `main` and re-tested before it merges. A
  pull request that passed before `main` moved has not been tested against
  today's `main`.
- **The reviewer agent.** The hive's reviewer reads every pull request
  against [the review rubric](review-rubric.md). On Tier 2 it is the only
  reader before the change reaches machines. A finding it raises is fixed or
  answered before merge.
- **No human merge.** Tier 2 means the most scrutiny, not a person's
  approval. The pull request states its machine impact (daemon-reload,
  image-before-ini, no proprietary app baked in, how it was tested).
- **The owner's brakes.** The `hold` label stops one pull request; pausing
  the repository in the hive stops all agent work
  ([runbook](ai-ops-runbook.md#the-hold-label)). An agent may add `hold`
  when it finds a P0 or P1 problem, and says why; it never removes it.
- **An agent never widens its own boundary.** Changes to
  `.claude/settings.json`, `.claude/hooks/**`, `policies/`,
  `scripts/check-policies.mjs` or `risk-config.json` are reviewed as Tier 2
  whoever wrote them ([AI security policy](security/SECURITY-AI.md)).

## If you are an agent

1. Read `AGENTS.md`, then `CLAUDE.md`, then
   [working-on-the-repo.md](working-on-the-repo.md).
2. Pass `-R Danathar/appbox` on every `gh` command.
3. One issue, one branch from `origin/main`, one pull request.
4. Never run `host/appbox-update` or `host/install` for real; never touch the
   real `apps` box.
5. Find your tier (`node scripts/check-policies.mjs --classify <paths>`), run
   its required commands, and say in the pull request which ran and which
   could not. On Tier 2, state the machine impact.
6. Leave the merge to the lane.
