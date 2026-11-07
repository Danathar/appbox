# Change risk tiers

How to classify a change to appbox, and what each tier requires before it
merges. Reviewers (human or agent) and authors both use it.

**There is no human merge gate in this repository.** appbox runs on a fully
autonomous hive. An agent pull request merges once the required check `test`
passes, on every tier, Tier 2 included. Nobody reads a Tier 2 change before
it reaches the machines. A tier sets how hard the reviewer agent looks and
what the pull request must say, not who merges it. So the real gate is
mechanical: the policies in [`policies/`](../policies/README.md), the tests,
and the e2e image build. If a Tier 2 invariant is not covered by one of
those, nothing stops a change that breaks it.

The owner's brakes are the `hold` label on a pull request and pausing the
repository in the hive (see the [runbook](ai-ops-runbook.md)).

This file is the source. [`risk-config.json`](../risk-config.json) restates
the table below as data, and `node scripts/check-policies.mjs` fails when the
two disagree. To change a tier, edit both in the same pull request.

## Why appbox needs tiers at all

appbox is small, but four facts make some of its files much more dangerous
than their size suggests:

- **`main` is live.** Every enrolled machine fast-forwards its checkout to
  `main` on its next timer run and runs `host/appbox-update` from it, as the
  user. There is no staging step. Code on `main` is code execution on every
  enrolled machine (README, "Trust tradeoff").
- **The image is public.** `ghcr.io/danathar/appbox` must stay
  redistributable. Signal is AGPL-3.0 and is baked in; Claude Desktop is
  proprietary and must only ever be installed at box start by
  `scripts/claude-desktop-sync`. Baking it in once publishes it.
- **The signing keys are the trust root.** `cosign.pub` is what every machine
  checks the image against, and `keys/ublue-os-toolboxes.pub` is what CI
  checks the base image against. Replacing either changes what "signed"
  means. The private half lives only in the `SIGNING_SECRET` repository
  secret and on the owner's machine.
- **The agent boundary.** `.claude/settings.json` and `.claude/hooks/**`
  decide what an agent may run. An agent that edits them edits its own
  limits.

## Tier table

Tier 2 is the most dangerous. `**` matches any depth, `*` matches within one
directory level.

| Tier | Name    | Covers                                                                                                                                                                                                                                                                                             | Required commands                                                                                                                                                                                                       | Scrutiny   |
| ---- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0    | docs    | `docs/**`, `*.md`, `tests/**`, `scripts/tests/**`, `.claude/memory/**`, `.claude/session-summary.md`, `.editorconfig`, `.gitignore`                                                                                                                                                                | none                                                                                                                                                                                                                    | `standard` |
| 1    | tooling | `.github/**`, `scripts/*.mjs`, `policies/**`, `risk-config.json`, `.claude/skills/**`, `.cursor/**`, `renovate.json`, `.shellcheckrc`, `.coverage-thresholds.json`                                                                                                                                 | `node scripts/check-policies.mjs`, `node --test scripts/tests/*.test.mjs .claude/hooks/tests/*.test.mjs`, `actionlint`                                                                                                  | `elevated` |
| 2    | live    | `host/**`, `hosts/**`, `distrobox.ini`, `ContainerFiles/**`, `scripts/appbox.sh`, `scripts/claude-desktop-sync`, `packages/**`, `keys/**`, `cosign.pub`, `.github/workflows/build-appbox.yml`, `.claude/settings.json`, `.claude/hooks/**`, `.github/CODEOWNERS`, `.github/rulesets/**`, `LICENSE` | `shellcheck host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync`, `bats tests/unit`, `node scripts/check-policies.mjs`, `node --test scripts/tests/*.test.mjs .claude/hooks/tests/*.test.mjs` | `highest`  |

A path no row lists is Tier 1.

Scrutiny values:

- `standard`: the `test` check passes. The reviewer agent checks the text is
  true about appbox as it is.
- `elevated`: as above, plus the reviewer agent reads the whole diff against
  [the review rubric](review-rubric.md), and the pull request says which
  required commands ran and what they printed. A change to a policy,
  `risk-config.json` or a workflow's permissions says whether it loosens a
  rule.
- `highest`: as above, plus the reviewer agent must review it before it
  merges, tests must cover the changed behaviour, and the pull request states
  its machine impact (next section). Every check in the rubric's Tier 2
  sections applies.

## What a Tier 2 pull request must state

Because it reaches machines unread, a Tier 2 pull request says, in its body:

- **Machine impact:** what reaches enrolled machines and when. A change to
  `host/appbox-update`, `distrobox.ini` or `hosts/*` lands on the next timer
  run through self-update. An image change lands at each machine's next
  recreate (weekly by default). See the table in
  [working-on-the-repo.md](working-on-the-repo.md#what-a-push-does).
- **daemon-reload:** whether `host/*.service` or `host/*.timer` changed. Self
  update pulls the new unit file but systemd keeps the old one loaded until
  each machine runs `systemctl --user daemon-reload` (re-running
  `host/install` does it). Say so, because no machine will do it on its own.
- **Image before ini:** if an ini change depends on something new in the
  image (a new app to export), the image change must already be on `main`
  with a green build. Two changes in one pull request, or the ini change
  merging first, lets a machine recreate with the new ini and the old image.
- **No proprietary app baked in:** that the image still carries only
  redistributable apps.
- **How it was tested** without touching a real `apps` box (the throwaway ini
  and `prctl` methods in working-on-the-repo.md, the bats tests, the e2e
  image build).

## How to apply it

1. List every path the change touches.
2. Take the **highest** tier any path matches. `scripts/tests/x.test.mjs`
   matches `scripts/tests/**` (Tier 0) and nothing higher, so it is Tier 0;
   `hosts/aurora-think.md` is a Markdown file but matches `hosts/**`, so it
   is Tier 2 (`*.md` covers only the top level).
3. Raise the tier, never lower it, when the change is riskier than its path
   says. Examples: a docs change that edits a command people copy and run on
   a machine (`host/install`, `distrobox assemble`); a test change that stubs
   out the signature check; a Tier 1 change that loosens a policy, the floor
   in `scripts/check-policies.mjs`, or a workflow's permissions.
4. Run every command in the tier's Required column. A pull request that spans
   tiers meets the requirements of its highest tier. `bats` and the e2e image
   build may not be available locally; say so in the pull request and rely on
   the CI jobs behind `test`.

`node scripts/check-policies.mjs --classify <path> ...` prints the tier the
table assigns to each path. It cannot see inside a file, so it does not apply
rule 3.

## Why these paths

- **`host/**`, `hosts/**`, `distrobox.ini`.** What every machine runs and how
  its box is built. Reach machines on the next timer run.
- **`ContainerFiles/**`, `scripts/appbox.sh`, `scripts/claude-desktop-sync`,
  `packages/**`.** What the public image contains, and the init hook that
  runs on every box start. A failing init hook stops the box and every app in
  it.
- **`keys/**`, `cosign.pub`, `.github/workflows/build-appbox.yml`.** The
  signature chain: the base image check, the build, the signing, and the
  public key machines verify against.
- **`.claude/settings.json`, `.claude/hooks/**`.** The agent boundary.
- **`.github/CODEOWNERS`, `.github/rulesets/**`.** Who is asked to review and
  what the branch ruleset requires. Loosening them loosens the only gate.
- **`LICENSE`.** Decides what anyone may do with the repository and the
  image built from it.
- **`.github/**` (other workflows), `scripts/*.mjs`, `policies/**`,
  `risk-config.json`.** CI and the checks that form the gate. They do not
  reach machines, but a weakened check lets the next Tier 2 change through
  unchecked. That is why the checker keeps a hard-coded floor
  ([policies/README.md](../policies/README.md#the-floor)).
- **`docs/**`, `*.md`, `tests/**`.** Nothing to deploy. Tests can hide a
  regression, which is why a test change that disables a check is raised by
  rule 3.

See also [the review rubric](review-rubric.md),
[the AI security policy](security/SECURITY-AI.md) and
[how agents share the repository](multi-agent.md).
