# Branch protection and serialized merging

`main` is live: every enrolled machine fast-forwards its checkout to `main` on
its next timer run and runs `host/appbox-update` from it, as the user. This
page says what protects `main`, why, and how to check that GitHub is really
enforcing it. Every command targets `Danathar/appbox`.

## Status

The ruleset in [`.github/rulesets/main.json`](../.github/rulesets/main.json) is
**active**. It was applied on 2026-11-07 as ruleset `RULESET_ID`. Check it
yourself; neither call needs admin rights:

```bash
gh api repos/Danathar/appbox/branches/main --jq .protected
gh api repos/Danathar/appbox/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

The first prints `true`; the second lists `protect main` as `active`. Anything
else means the ruleset was removed or disabled and `main` again accepts a
direct push.

Being active does not prove the rules are the ones in the file. Compare the
live ruleset with the file (prints nothing when they match):

```bash
diff <(gh api repos/Danathar/appbox/rulesets/RULESET_ID \
         --jq '{name,target,enforcement,conditions,bypass_actors,rules}' | jq -S .) \
     <(jq -S '{name,target,enforcement,conditions,bypass_actors,rules}' \
         .github/rulesets/main.json)
```

## Why

This repository runs on a fully autonomous Hive (ACMM L6): agent pull requests
merge once their required checks pass, with no person reading them first, and
that includes Tier 2 changes to what machines run (see
[`risk-tiers.md`](risk-tiers.md)). So the required checks are the gate, and
the ruleset is what makes them unavoidable. Without it, any token with
`contents: write` (the Hive GitHub App, a workflow, a person) could push to
`main`, and the next timer run would execute that push on every machine.

## The ruleset

[`.github/rulesets/main.json`](../.github/rulesets/main.json) is in GitHub's
import format, so it applies as-is.

- **Targets `~DEFAULT_BRANCH`**, so it follows a rename of `main`.
- **No bypass actors**, the owner included. Every change, including a new
  machine's `hosts/<hostname>.md`, arrives as a pull request with green
  checks. A bypass for Actions or for an App would hand back the direct push
  this exists to stop.
- **`deletion` and `non_fast_forward`** stop `main` being deleted or rewritten.
  That matters twice here: self-update only fast-forwards, so a rewrite would
  quietly stop every machine from updating (see
  [`working-on-the-repo.md`](working-on-the-repo.md)).
- **`pull_request` with 0 approvals.** GitHub does not let anyone approve their
  own pull request, so on a single-maintainer repository one required approval
  would mean nothing could merge. What 0 still enforces is that every change
  arrives as a pull request that passed the required checks.
- **Three required checks**, all GitHub Actions (`integration_id` 15368):

  | Check           | Workflow                                                      | What it covers                                                                                                     |
  | --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `test`          | [`ci.yml`](../.github/workflows/ci.yml)                       | Passes only when shellcheck, actionlint, both unit test legs, the Node tests and the E2E image build all succeeded |
  | `Coverage gate` | [`coverage-gate.yml`](../.github/workflows/coverage-gate.yml) | Line coverage of `host/appbox-update` and `host/install` stays above `.coverage-thresholds.json`                   |
  | `policy-check`  | [`policy-check.yml`](../.github/workflows/policy-check.yml)   | The policies in [`policies/`](../policies/README.md), such as no proprietary app in the image and pinned actions   |

  All three workflows run on every pull request to `main` with no path filter,
  so no pull request waits for a check that never starts. Renaming one of these
  jobs (its `name:`), or adding a path filter, blocks every merge until this
  file and the live ruleset are updated to match; see "Renaming a required
  check".
- **A pull request merges only with `main`'s current head in it**
  (`strict_required_status_checks_policy: true`). The required checks have then
  run on what will land, not on a stale base.

## Merge queue

GitHub's merge queue is offered only to repositories owned by an organization,
and this one is under a personal account, so the ruleset has no `merge_queue`
rule. The same guarantee comes from two pieces together:

1. The up-to-date rule above: every pull request carries `main`'s current head
   and has passed the required checks on it.
2. Hive's serialized merge lane (`merge_strategy: hive-serialized`): Hive merges
   one pull request at a time and re-validates the next one against the new
   `main`, so two agent pull requests that pass on their own cannot break
   `main` together.

The ACMM evaluation credits its Merge queue criterion when both hold. The Hive
side is a setting on the Hive dashboard, not a file in this repository. It read
back as `hive-serialized` on 2026-11-07 from an authenticated
`GET /api/repos/merge-strategy?repo=appbox` on the Hive dashboard API.

## Applying or changing the ruleset

A pull request cannot change repository settings; a repository admin applies
the file. First time:

```bash
gh api --method POST repos/Danathar/appbox/rulesets --input .github/rulesets/main.json
```

To change it, edit the file in a pull request, then after it merges update the
live ruleset from the file:

```bash
gh api --method PUT repos/Danathar/appbox/rulesets/RULESET_ID --input .github/rulesets/main.json
```

### Renaming a required check

That order deadlocks when a pull request renames a required job: the pull
request reports only the new name while the live ruleset waits for the old
one, so it can never merge. Stage it instead:

1. Open the pull request that renames the job and changes
   `.github/rulesets/main.json` to the new name. Wait for its new check to pass.
2. While it is open, PUT the file from that branch to the live ruleset (the
   command above, run in a checkout of the branch). The pull request can now
   merge on its new check.
3. Merge it, then run the diff above against `main` to confirm the live rules
   and the file agree.

Do step 3 straight after step 2: until the rename is on `main`, other pull
requests still report the old name and cannot merge.

## When there is a second reviewer

Set `required_approving_review_count` to 1 and consider
`require_last_push_approval`, so a push after approval needs a fresh one.
