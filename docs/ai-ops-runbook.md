# AI operations runbook

For the owner. How to notice each automated signal in appbox, what to check
first, what to do, and how to stop the automation.

**Two facts shape everything here.** Agent pull requests merge once the
required check `test` passes, on every tier, with no human reading them
([risk tiers](risk-tiers.md)). And `main` is live: every enrolled machine
fast-forwards to it and runs `host/appbox-update` from it on its next timer
run. So a bad merge is on the machines by the next morning, and the brakes
below are the way to stop one before it lands.

**Safety rule.** Nothing in this runbook, and no agent, runs
`host/appbox-update` against the real `apps` box to "see what happens"
without first checking for yourself that Signal and Claude are closed
(`pgrep -ax 'claude-desktop|signal-desktop'`). Test with the throwaway ini
method in [working-on-the-repo.md](working-on-the-repo.md#testing-changes-to-the-update-script-safely).
Every `gh` command here passes `-R Danathar/appbox`.

| Signal or need                               | Section                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stop one pull request from merging           | [The `hold` label](#the-hold-label)                                                         |
| Stop all agent work on the repository        | [Pause and resume the repository in the hive](#pause-and-resume-the-repository-in-the-hive) |
| What each workflow does, how to turn one off | [Workflows](#workflows)                                                                     |
| `test` or another check red on `main`        | [A red `main`](#a-red-main)                                                                 |
| The image build failed                       | [The image build failed](#the-image-build-failed)                                           |
| A bad change reached the machines            | [Undoing a bad change](#undoing-a-bad-change)                                               |
| A machine stopped following `main`           | [A machine stopped updating](#a-machine-stopped-updating)                                   |
| A key or token showed up somewhere           | [A leaked secret](#a-leaked-secret)                                                         |
| An agent is looping or doing the wrong thing | [A runaway agent](#a-runaway-agent)                                                         |
| A scheduled run never appeared               | [A scheduled run did not fire](#a-scheduled-run-did-not-fire)                               |

## The `hold` label

The owner's brake on a single pull request. A pull request labeled `hold` is
not merged by the hive, whatever its checks say. Remove the label to let it
continue. Use it on any Tier 2 pull request you want to read first, or when a
review raises a P0 or P1.

```sh
gh pr edit <N> -R Danathar/appbox --add-label hold
gh pr edit <N> -R Danathar/appbox --remove-label hold
gh pr list -R Danathar/appbox --label hold
```

The label has to exist in the repository first. If `gh label list -R Danathar/appbox`
does not show it, create it once:
`gh label create hold -R Danathar/appbox --description "Do not merge until the owner removes this"`.

An agent never removes `hold`. An agent may add it, to stop a pull request
it has found a P0 or P1 problem in, and says why in a comment; only the owner
takes it off.

## Pause and resume the repository in the hive

The hive is outside this repository. Its per-repository pause stops agent
activity on `Danathar/appbox` only and leaves the dashboard card, counts and
ACMM evaluation in place. It is a different switch from pausing one agent
(everywhere) or the whole fleet. The repository was paused while the ACMM
onboarding pull requests were written.

- **Dashboard:** on the repository's card, press "pause" (it asks for a
  reason) or "resume".
- **API:** `POST /api/repos/pause` with `{"repo": "appbox", "reason": "..."}`,
  `POST /api/repos/resume` with `{"repo": "appbox"}`, and
  `GET /api/repos/pauses` to list. Owner only.

Pausing does not stop GitHub workflows (turn those off below), the Codex
connector, or a local Claude Code session, and it does not undo anything
already merged. To check that agents have stopped:

```sh
gh pr list -R Danathar/appbox --state all --author app/danathar-atomic-hive --limit 5 --json number,createdAt,title
```

## Workflows

All live in [`.github/workflows/`](../.github/workflows/). Each file's header
comment is the source of truth for what it does; this table only names them.
Some arrive with the ACMM onboarding pull requests and may not be on `main`
yet.

| File                     | Purpose                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `build-appbox.yml`       | builds the image on pull requests; on `main`, daily and on demand also pushes, signs and verifies it            |
| `ci.yml`                 | shellcheck, bats unit tests, node tests and the e2e image build; its aggregate job `test` is the required check |
| `coverage-gate.yml`      | fails when shell coverage under the bats tests drops below `.coverage-thresholds.json`                          |
| `policy-check.yml`       | runs `scripts/check-policies.mjs` and its tests ([policies](../policies/README.md))                             |
| `labeler.yml`            | labels pull requests by the paths they touch (`.github/labeler.yml`)                                            |
| `nightly-compliance.yml` | re-runs the checks against `main` every night and reports failures in one tracking issue                        |
| `auto-issues.yml`        | opens or updates a tracking issue when a run on `main` fails                                                    |
| `agent-audit.yml`        | checks merged agent pull requests for a linked issue, a signature line and the expected merger                  |
| `auto-qa.yml`            | proposes raising coverage floors in an issue; never lowers one                                                  |
| `ai-fix.yml`             | asks an AI agent to verify and apply review findings on request                                                 |
| `claude.yml`             | runs Claude Code when mentioned on an issue or pull request                                                     |
| `pr-metrics.yml`         | reports pull request metrics ([metrics](metrics.md))                                                            |

Workflows that need a model credential skip cleanly when it is not set.

To turn one off without deleting it (reversible):

```sh
gh workflow list -R Danathar/appbox --all
gh workflow disable <file>.yml -R Danathar/appbox
gh workflow enable <file>.yml -R Danathar/appbox
```

Disabling `ci.yml` leaves every pull request waiting for a `test` status that
never arrives, so nothing merges. That is a blunt brake, but it works. To
remove a workflow for good, delete it in a pull request.

## A red `main`

Signal: `test` or another check fails on a push to `main`, or
`auto-issues.yml` or `nightly-compliance.yml` opened a tracking issue.

```sh
gh run list -R Danathar/appbox --branch main --limit 10
gh run view <run-id> -R Danathar/appbox --log-failed
```

1. **Which job.** shellcheck and bats point at a script; node tests at
   tooling, hooks or a policy (the policy test says which rule and which
   line); the e2e build at the image.
2. **The last commit or the environment.** Re-run once
   (`gh run rerun <run-id> -R Danathar/appbox --failed`). A pass is a flake;
   note it in the tracking issue. New runner images, vendor packages and
   sigstore outages are the usual outside causes.
3. **Decide whether machines are affected.** A red check on a docs or
   tooling change is a CI problem. A red check on a merged change to
   `host/`, `hosts/`, `distrobox.ini` or the image may already be on
   machines: go to [Undoing a bad change](#undoing-a-bad-change).
4. **Fix forward or revert by pull request.** Never push to `main`
   directly and never rewrite it.
5. **Close the tracking issue by hand** when `main` is green; the scheduled
   workflows do not close their own issues.

## The image build failed

Signal: `build-appbox` is red on `main` or on the daily schedule. Machines
keep the image they have; nothing new is pushed or signed, so a failed build
is safe but stale.

- **"Verify base image signature" failed.** ublue's base image is unsigned,
  signed with a different key, or the check could not reach sigstore. Do not
  remove the check. Look at ublue's toolboxes repository for a key change
  before touching `keys/ublue-os-toolboxes.pub`.
- **`Base image is Ubuntu X, but UBUNTU_VERSION is Y`.** ublue moved
  `ubuntu-toolbox:latest` to a new release. This is the guard working. Follow
  "Ubuntu release upgrades (EOL)" in the README.
- **`Key fingerprint mismatch`.** Signal or Anthropic changed their apt key.
  Check the vendor's current instructions before changing the pinned
  fingerprint in `scripts/appbox.sh`.
- **`claude-desktop must not be installed in the image`.** Something pulled
  Claude Desktop into the image. Find what (a dependency change on
  Anthropic's side, or a package added to `packages/appbox.packages`). Never
  "fix" it by removing the check.
- **`apt-get install` failed.** A package was renamed or removed upstream;
  fix `packages/appbox.packages`.
- **"Install cosign" failed.** Usually a sigstore outage. Machines are not
  affected: their `cosign verify` keeps working. Re-run later.
- **"Sign container image" or "Verify signature" failed.** The
  `SIGNING_SECRET` does not match `cosign.pub`, or it is missing. See
  [A leaked secret](#a-leaked-secret) for rotation.

## Undoing a bad change

From [working-on-the-repo.md](working-on-the-repo.md#undoing-a-bad-change):

- **Script, ini or settings:** `git revert` the commit in a pull request.
  Machines pick it up on their next run. Add `hold` to any other open pull
  request that touches the same files until the revert has merged.
- **Bad image:** revert and let CI rebuild. To roll one machine back now,
  point `image=` at an older dated tag (`ghcr.io/danathar/appbox:YYYYMMDD`)
  in that machine's ini, quit the apps, and run `host/appbox-update --force`.
- **Bad app version:** an older image does not pin Signal or Claude, because
  the daily run upgrades them in place. Hold one back in the box with
  `sudo apt-get install --allow-downgrades <pkg>=<version>` then
  `sudo apt-mark hold <pkg>`; the hold lasts until the next rebuild. Signal
  cannot go below the version that last wrote its database.
- **Machine broken right now:**
  `distrobox assemble create --replace --file ~/claude/appbox/distrobox.ini`
  rebuilds the box directly. App data in `~/.config` is not touched.
- **A unit file change:** after the fix merges, each machine still needs
  `systemctl --user daemon-reload` (or `host/install` re-run).

To stop a machine taking further changes while you sort it out, set
`APPBOX_SELF_UPDATE=0` in its environment (a systemd drop-in) or run
`systemctl --user disable --now appbox-update.timer` on it.

## A machine stopped updating

Signal: a machine's journal shows `Could not update ...; continuing with
<sha>` every run, or `host/appbox-update --show-config` shows an old
checkout.

```sh
git -C ~/claude/appbox status -sb
journalctl --user -u appbox-update -n 50
```

Local edits or local commits block the fast-forward; commit and push them,
or discard them. If `main` was ever rewritten, every machine needs
`git -C ~/claude/appbox fetch && git -C ~/claude/appbox reset --hard origin/main`
by hand, which discards local changes there. This is why `main` is never
rewritten.

## A leaked secret

The secrets are `SIGNING_SECRET` (the cosign private key), any model
credential the AI workflows use, and the owner's own tokens.

1. **Revoke or rotate first**, before cleaning anything up. For the signing
   key: generate a new pair on the owner's machine, set it with
   `gh secret set SIGNING_SECRET -R Danathar/appbox < cosign.key` (never with
   the value on the command line), commit the new `cosign.pub`, and let CI
   re-sign. Machines get the new public key through self-update. This is a
   Tier 2 change; put `hold` on any other pull request touching keys.
2. Turn off the workflow that used it until a new one is set.
3. Remove it from the visible surface. A revert does not remove it from
   history; decide about that separately, and never rewrite `main` without a
   plan for every machine.
4. Record what happened without the value.

## A runaway agent

Signal: many pull requests or comments in a short time, the same files
rewritten again and again, or work outside its issue.

1. **Pause the repository in the hive** (above). Disable `ai-fix.yml` and
   `claude.yml` if a workflow agent is involved.
2. **Hold what is queued.** Add `hold` to its open pull requests so none
   merges while you look:
   `gh pr list -R Danathar/appbox --state open --author app/danathar-atomic-hive`.
3. **Stop running workflows:**
   `gh run list -R Danathar/appbox --status in_progress`, then
   `gh run cancel <run-id> -R Danathar/appbox`.
4. **Check what merged:**
   `gh pr list -R Danathar/appbox --state merged --author app/danathar-atomic-hive --limit 20`,
   and the `agent-audit.yml` summary. Anything that touched Tier 2 paths may
   already be on machines; see [Undoing a bad change](#undoing-a-bad-change).
5. **Find why** before resuming: the issue text it followed, `AGENTS.md`,
   and the agent boundary in `.claude/settings.json`. Fix the instruction,
   not just the output.

## A scheduled run did not fire

Scheduled workflows run only from the default branch, can be delayed under
load, and GitHub disables schedules in a repository with no activity for 60
days. Check with `gh workflow list -R Danathar/appbox --all`, re-enable with
`gh workflow enable <file>.yml -R Danathar/appbox`, and start one by hand
with `gh workflow run <file>.yml -R Danathar/appbox`.

The machines' own timer is separate: `appbox-update.timer` fires daily at
04:30 with up to 15 minutes of random delay and `Persistent=true`, so a
laptop that was asleep runs it when it wakes. Check on the machine with
`systemctl --user list-timers appbox-update.timer`.
