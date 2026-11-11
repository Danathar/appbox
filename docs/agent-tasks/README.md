# Agent task ledgers

How to start from a change in `Danathar/appbox` and find the task that
produced it, and how this directory records that. Rules for agents are in
[AGENTS.md](../../AGENTS.md). Every `gh` command here passes
`-R Danathar/appbox`.

## What a ledger is

One file per working session, named `YYYY-MM-DD.md` (add `-2`, `-3` for a
second session on the same day). It lists each task as one row:

| Column  | Meaning                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------- |
| issue   | The GitHub issue or issues the work answers, `#N` with its title.                                       |
| branch  | The branch the work was done on.                                                                        |
| PR      | The pull request number once one exists, `-` before that. Never guess one.                              |
| outcome | `open`, `merged`, `closed unmerged` or `abandoned`, with the reason when it is not `merged`.            |
| agent   | Who did it: a hive agent (`agent=<name>` from the signature line), or a local session (tool and model). |

A ledger records what was planned and what happened in that session. Fill in
the PR and outcome as they become known. Do not rewrite history in it: if a
later fact contradicts a row, add a dated note under the table. Each issue
appears in one row of one ledger.

Who writes it: the session that plans or coordinates the work, or a single
agent working one issue, in the same pull request as the work or in a
follow-up once the PR number is known. Small changes with no issue (a typo, a
Renovate merge) need no row.

## Following one change end to end

```text
file/line --git blame--> commit --gh api repos/Danathar/appbox/commits/<sha>/pulls--> PR
PR --"Fixes #N" lines--> issue (the task statement)
PR --author and signature line--> agent
issue, branch or PR --this directory--> the ledger row
```

The marks a change carries, and how to read them:

- **Closing reference.** Agent PRs carry one `Fixes #N` line per issue:

  ```sh
  gh pr view <N> -R Danathar/appbox --json closingIssuesReferences \
    --jq '[.closingIssuesReferences[].number]'
  ```

- **Signature.** Hive PRs end with a `hive: agent=<name>` line. PRs from a
  local Claude Code session end with a "Generated with Claude Code" line and a
  session link, and their commits carry `Co-Authored-By` and
  `Claude-Session` trailers. A PR opened by the owner may carry none of these;
  do not read "unsigned" as "written by a person".
- **Branch name.** The ACMM onboarding used `acmm/<slug>`. A deleted branch
  survives in the PR record:

  ```sh
  gh pr list -R Danathar/appbox --state all --head <branch> --json number,state,mergedAt
  ```

- **Audit.** `.github/workflows/agent-audit.yml` reports agent PRs that lack a
  closing reference or a signature. `.github/workflows/agent-signature.yml`
  checks the signature earlier, on the open PR, as an advisory check.

None of these marks is enforced on every change; the ledger is where a gap is
closed by hand.

## Ledgers

- [2026-11-07](2026-11-07.md): ACMM onboarding, issues #16 to #59 and #63.
