# PR metrics

What this repository measures about its own pull requests, how each number is
defined, and how to recompute it. The point is to see whether agent-written
changes are being accepted, and how often one has to be fixed again after it
merges. The numbers move every week; the definitions and commands here are
the durable part. Dated readings are in [`docs/metrics/`](metrics/README.md).
The repository is public, so those files are also the public record.

## What is computed

[`scripts/pr-metrics.mjs`](../scripts/pr-metrics.mjs) lists every pull
request of `Danathar/appbox` through the GitHub API (read-only) and reports,
for two windows and for each author class:

| metric                 | definition                                                               |
| ---------------------- | ------------------------------------------------------------------------ |
| opened                 | PRs created inside the window                                            |
| merged                 | PRs merged inside the window                                             |
| closed unmerged        | PRs closed without merging inside the window                             |
| open                   | PRs still open at report time, whatever their age                        |
| acceptance             | merged / (merged + closed unmerged); `n/a` when nothing was decided      |
| median / p90 to merge  | time from opened to merged, over the PRs merged in the window            |
| needed a follow-up fix | share of the PRs merged in the window that a later merged PR fixed       |
| merged by              | who merged them: the Hive app, the owner, another person, or another bot |

Open PRs are left out of the acceptance rate because nothing has been decided
about them yet. The median of an even count is the mean of the two middle
values; the p90 is the nearest-rank value, without interpolation. A follow-up
fix has to arrive within 14 days of the merge (`--follow-up-days` changes
that); how one is recognized is explained below.

The windows are **all time** and the **last 30 days** (`--window-days`
changes the 30). A merged or closed PR belongs to a window by the date it was
merged or closed, not by the date it was opened. So a PR opened 40 days ago
and merged yesterday counts as merged in the last 30 days, and its 40-day wait
counts in that window's time to merge, but it does not count as opened there.

### Author classes

| class           | who                                                                  |
| --------------- | -------------------------------------------------------------------- |
| agent           | PRs written by an AI agent (the rules are below the table)           |
| human           | everyone else who is not a bot                                       |
| dependency bots | Renovate and Dependabot                                              |
| other bots      | any other bot account, such as `github-actions` with no agent marker |

A PR is an agent PR when its author is the Hive app (`danathar-atomic-hive`)
or another agent app (`claude`, `copilot-swe-agent`,
`chatgpt-codex-connector`), when its body carries a Claude Code marker
(`Generated with [Claude Code]`, a `Claude-Session:` line or a
`Co-Authored-By: Claude` line), or when it has the `ai-generated` label.

The marker rule matters here because much of the agent work on appbox is done
by Claude Code sessions running under the owner's own GitHub login. GitHub
records those PRs as the owner's; the footer Claude Code adds to the PR body
is what tells them apart. PRs that the `Claude` and `AI fix` workflows open
are authored by `github-actions` and carry the same footer. A PR written by a
person with no marker, or by an agent whose marker was deleted, lands in the
wrong class; the script cannot see any further than that.

Dependency bots get their own class because their PRs are neither agent nor
human work, and on a young repository they are most of the traffic. Mixing
them in would make both other rows meaningless.

### How a follow-up fix is recognized

A merged PR B counts as a follow-up fix of an earlier merged PR A when B was
opened after A merged and no more than 14 days later, B was not written by a
dependency bot, and either:

- B's title is GitHub's revert title for A (`Revert "<A's title>"`), or
- one line of B's title or body names `#A` together with a fix word: fix,
  fixes, fixed, follow-up, revert, regression, broke, broken, hotfix.

The test is deliberately simple and errs toward missing a fix rather than
inventing one. A fix that does not mention the PR it fixes is not counted.
Neither is a fix that mentions only the issue the PR closed, nor a fix pushed
as an extra commit to the same PR before it merged. Dependency-bot PRs are
never counted as fixes: their bodies quote upstream release notes, full of
`fix ... #N` lines that point at upstream issues, not at appbox PRs. The JSON
output lists every pair it found (`followUp.prs`), so each one can be checked
by hand.

## Run it locally

The script needs only Node (no npm packages) and a token that can read the
repository. `gh auth token` prints the one `gh` already uses; passing it
inline keeps it out of your shell history and out of files:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/pr-metrics.mjs                # markdown tables
GITHUB_TOKEN="$(gh auth token)" node scripts/pr-metrics.mjs --format json  # machine-readable
```

Options:

| option                 | effect                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `--repo owner/name`    | repository to read (default `Danathar/appbox`)                                                            |
| `--now <ISO time>`     | report time; fixes the windows so a saved input reproduces the same output                                |
| `--window-days <n>`    | length of the recent window (default 30)                                                                  |
| `--follow-up-days <n>` | how long after a merge a fix still counts as its follow-up (default 14)                                   |
| `--owner <login>`      | whose merges count as "owner" (default `Danathar`)                                                        |
| `--json-out <file>`    | also write the JSON report to a file                                                                      |
| `--save-input <file>`  | write the PR list that was read, so the run can be repeated offline. Dependency-bot bodies are left out   |
| `--input <file>`       | read a saved PR list instead of calling GitHub. Also accepts `gh pr list --json` and REST `/pulls` output |

The script never writes to GitHub, and with `--input` and `--now` it makes no
network call at all. Its tests use fixture data only:
`node --test scripts/tests/pr-metrics.test.mjs`.

## Weekly run

[`.github/workflows/pr-metrics.yml`](../.github/workflows/pr-metrics.yml)
runs every Monday at 06:23 UTC, and on demand from the Actions tab (where the
window length can be changed). It runs the script with the workflow's own
read-only token, writes the markdown to the run's step summary, and uploads
`pr-metrics.md` and `pr-metrics.json` as the `pr-metrics` artifact, kept for
90 days. It needs no secret, commits nothing (machines run `main`, and a
report has no reason to push there), and opens no issue. Runs are listed at
<https://github.com/Danathar/appbox/actions/workflows/pr-metrics.yml>.

## How to read the numbers

- **The agent row is the one to watch.** Acceptance rate counts how often a
  decided PR was merged rather than closed. An agent PR closed unmerged is
  the useful event: it means a change was proposed that should not have
  been, or was superseded.
- **The follow-up share is the quality signal.** A merged agent PR that
  needed a revert or a fix within two weeks got past review and CI with a
  problem in it. On appbox that matters more than usual, because `main` is
  live: a merged change reaches every enrolled machine on its next timer run.
- **Merged by is data, not a verdict.** appbox runs on an autonomous
  hive, so agent PRs that pass the required checks are merged by the Hive
  app, and that is the intended flow. The column shows how the work is being
  merged; it is not a count of anything going wrong.
- **Time to merge** is mostly CI time plus the wait for review, and for
  dependency bots it also reflects Renovate's own schedule. Read the p90 for
  the slow tail, and read neither without the sample size in the JSON
  (`timeToMergeHours.samples`).
- **Dependency-bot acceptance is low by design.** Renovate closes its own
  PRs when a newer update replaces them ("autoclosed"), and several early
  Dependabot PRs were closed unmerged while the repository was settling on
  Renovate as its only dependency bot. That says nothing about agent or
  human work.
- **Small samples.** With fewer than about ten decided PRs in a row, treat
  percentages as anecdotes. The first snapshot
  ([2026-11-07](metrics/2026-11-07.md)) has two agent PRs and no human ones.

## Not measured

- **Throughput or velocity.** Optimizing for PR count would reward rushing.
- **Review findings per PR.** Review bots post inline comments in different
  shapes, and counting them would measure the reviewer more than the change.
  How findings are judged is in [review-rubric.md](review-rubric.md).
- **What happens on machines.** A change can merge cleanly and still fail on
  a machine's next timer run. That shows up in
  `journalctl --user -u appbox-update` on each machine, not in GitHub data.
