# Quality dashboard

Which quality signals appbox has, where each one lives, and how to read it.
There is no hosted dashboard: the signals are GitHub Actions runs, issues
opened by scheduled workflows, and committed files. This page is the index.
Runs are at <https://github.com/Danathar/appbox/actions>.

**Why these signals carry weight.** Agent pull requests merge once the
required check `test` passes, on every tier, with no human reading them
first ([risk tiers](risk-tiers.md)). So a green `test` is the decision, not
a hint. A signal that is missing or flaky is a hole in the gate, not just a
noisy dashboard.

**State when written (2026-11-07).** On `main` only `build-appbox.yml`
existed. The other workflows below arrive in the ACMM onboarding pull
requests, which were opened together; each workflow's own header is the
source of truth for what it does once it is on `main`. This page does not
copy their job lists, so it cannot drift from them.

## Signals

| Signal             | Where it lives                                                                                           | What it tells you                                                                                                                             | Blocks merge                      |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `test`             | `.github/workflows/ci.yml`, the aggregate job named `test`                                               | every CI job passed: shellcheck on the shell scripts, the bats unit tests, `node --test` over the tooling and hook tests, the e2e image build | yes, the one required check       |
| e2e image build    | a job in `ci.yml`, tests in `tests/e2e/`                                                                 | the image still builds and its smoke checks pass, before anything is pushed                                                                   | yes, through `test`               |
| coverage gate      | `.github/workflows/coverage-gate.yml`, floor in `.coverage-thresholds.json`                              | line coverage of the shell scripts under the bats tests has not dropped below the floor                                                       | see the workflow header           |
| policy check       | `.github/workflows/policy-check.yml`, `scripts/check-policies.mjs`, [`policies/`](../policies/README.md) | workflow hygiene, the image and updater invariants, repository target, no committed secrets, risk-tier drift                                  | yes, through `test` (below)       |
| image build        | `.github/workflows/build-appbox.yml`                                                                     | on a pull request: the image builds (no push, no signing). On `main` and daily: built, pushed, signed and verified                            | no (not required); red is serious |
| nightly compliance | `.github/workflows/nightly-compliance.yml`                                                               | the checks re-run every night against `main`, so drift in a base image or vendor repo shows up without a pull request                         | no, opens or updates one issue    |
| auto issues        | `.github/workflows/auto-issues.yml`                                                                      | a red run on `main` becomes a tracking issue                                                                                                  | no, notification                  |
| agent audit        | `.github/workflows/agent-audit.yml`, `scripts/ai-audit-report.mjs`                                       | merged agent pull requests have a linked issue, a signature line and the expected merger                                                      | no, report                        |
| auto-QA            | `.github/workflows/auto-qa.yml`, `.github/auto-qa-tuning.json`, `scripts/auto-qa-tuner.mjs`              | proposes raising coverage floors when the tests allow it; never lowers one                                                                    | no, report                        |
| PR metrics         | `.github/workflows/pr-metrics.yml`, `scripts/pr-metrics.mjs`, [`metrics.md`](metrics.md)                 | acceptance rate and time to merge, by author                                                                                                  | no, report                        |
| Codex review       | `chatgpt-codex-connector[bot]` comments, `P0`-`P3`                                                       | an outside review of a pull request ([review rubric](review-rubric.md))                                                                       | no, advisory; may not post at all |

**Why the policies block through `test`.** `ci.yml` runs `node --test` over
`scripts/tests/`, and `scripts/tests/check-policies.test.mjs` includes a test
that the whole tree passes every policy. So a policy violation turns `test`
red even though `policy-check.yml` is a separate workflow. `policy-check`
reports the same violations with a plainer message.

`build-appbox.yml` is not part of `test`, because it already runs on its own
schedule and on every push that changes the image. Its pull request run is
still the real proof that an image change builds; read it on any Tier 2
image change.

## How to read them

- **Start with `test` on the pull request.** If it is red, the failing job
  says which layer: shellcheck, bats, node tests, or the image build.
- **For an image change, also read the `build-appbox` run** on the pull
  request, and after merge the push run on `main`: that is the one that
  signs and verifies. A machine only picks the new image up at its next
  recreate.
- **A green `main` is not the same as healthy machines.** Machines report to
  their own journal, not to GitHub. The only way to know a machine applied
  an update is on the machine
  (`journalctl --user -u appbox-update`, `host/appbox-update --show-config`).
- **Green on a stale branch says little.** Check the branch is current with
  `main` before trusting it.
- **Scheduled reports open issues, they do not fix anything.** An open
  nightly or auto-issues tracking issue means `main` or its inputs changed
  under it; see the [runbook](ai-ops-runbook.md#a-red-main).

Commands:

```sh
gh run list -R Danathar/appbox --branch main --limit 10
gh run list -R Danathar/appbox --workflow build-appbox.yml --limit 5
gh run view <run-id> -R Danathar/appbox --log-failed
gh pr checks <N> -R Danathar/appbox
```

## Known weak spots

- **Machines are not observed.** Nothing reports a failed update on a
  machine back to the repository. `docs/TODO.md` has "Notify on update
  failure" (an `OnFailure=` unit) for the user side.
- **The e2e build cannot open an app.** It can check that packages, launchers
  and the init hook are in place; it cannot click Signal. Behaviour with a
  real open app is pinned by the bats tests with stubs and by the manual
  methods in working-on-the-repo.md.
- **Vendor repos change under us.** Signal and Anthropic publish new
  versions daily, and the daily image build picks them up without a pull
  request. A broken vendor package shows up as a red scheduled build, not in
  review.
- **Policies check presence and order, not correctness**
  ([policies/README.md](../policies/README.md#what-the-checker-does-not-defend-against)).
- **Acceptance rate needs an independent decider.** While agents author and
  the hive merges, the rate says more about the checks than about quality
  ([metrics.md](metrics.md)).
