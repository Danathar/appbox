# Policies as code

JSON policies that `node scripts/check-policies.mjs` evaluates against the
repository tree. The `policy-check` workflow
([`.github/workflows/policy-check.yml`](../.github/workflows/policy-check.yml))
runs it on every pull request and every push to `main`. Its tests are in
[`scripts/tests/check-policies.test.mjs`](../scripts/tests/check-policies.test.mjs)
(`node --test scripts/tests/check-policies.test.mjs`). Node built-ins only.

**Why this matters more here than usual.** appbox has no human merge gate:
agent pull requests merge once the required checks pass, Tier 2 included
([risk tiers](../docs/risk-tiers.md)). Nobody reads a change to the image or
the updater before it reaches the machines. The rules below are how the
Tier 2 invariants are actually enforced. If an invariant is not here, or in
a test, nothing enforces it.

Changing a policy is a Tier 1 change. A change that loosens one is raised to
Tier 2 by the reviewer (risk-tiers.md, "How to apply it"), and some rules
cannot be loosened by editing JSON alone (see [the floor](#the-floor)).

To run it:

```sh
node scripts/check-policies.mjs                         # check this tree
node scripts/check-policies.mjs --classify host/install # print a path's tier
node --test scripts/tests/check-policies.test.mjs       # the checker's tests
```

## workflow-permissions.json

For every `.github/workflows/*.yml`:

- **Top-level `permissions:`** is present and grants no write: `{}`,
  `read-all` or `<scope>: read` only. Write scopes go on the job that needs
  them. Without a top-level block the token gets the repository default.
- **One exception, `build-appbox.yml`.** It predates this policy and has no
  top-level block; its only job declares `contents: read`,
  `packages: write`, `id-token: write`. `jobPermissionsSuffice` accepts that
  only while every job in the file declares its own `permissions:`, so a new
  job without one fails. The fix (add `permissions: {}` at the top) is a
  Tier 2 change to the build workflow; once it lands, remove the entry. The
  floor allows no other file in this list.
- **Every `uses:` is pinned** to a 40-character commit SHA with the tag in a
  trailing comment (`uses: actions/checkout@<sha> # v7.0.1`), including
  `actions/*`. Local `./` and `docker://` references are skipped.
- **`pull_request_target`** may be used (a labeler commonly does, so pull
  requests from forks can be labeled), but such a workflow must not reference the pull request head:
  no `github.event.pull_request.head.sha|ref|repo`, `github.head_ref`,
  `refs/pull/` or `merge_commit_sha`. It runs with a write token, so checking
  out or running fork code there hands that token to the fork.
- **No event text in `run:`.** Expressions such as
  `${{ github.event.issue.title }}`, `github.head_ref` or `inputs.*` inside a
  `run:` script are rejected; pass them through `env:` and read `"$VAR"`.
  Numbers, SHAs and the repository name are allowed
  (`forbiddenRunExpressions`).

## image-safety.json

The Tier 2 invariants of the image and of `host/appbox-update`.

- **No proprietary package in the public image.** `claude-desktop` must not
  appear in `packages/appbox.packages`, and no `apt-get`/`apt`/`aptitude`
  install or `dpkg -i` in `scripts/appbox.sh` or `ContainerFiles/appbox` may
  name it. A simulated install (`apt-get install -s`, used to list Claude's
  dependencies) is allowed. A longer name such as `claude-desktop-sync` is
  not the package; a version pin, arch suffix or `.deb` file name is.
- **The build-time guard stays.** In `scripts/appbox.sh`, after the last
  `apt-get install`, the `dpkg-query ... claude-desktop` check and its
  `exit 1` must remain (sequence `image-no-proprietary`).
- **The signing chain stays, in order** (sequence `build-signing`, in
  `build-appbox.yml`): verify the base image with
  `cosign verify --key keys/ublue-os-toolboxes.pub`, build, push,
  `cosign sign`, then `cosign verify --key cosign.pub`.
- **The updater verifies before it replaces** (sequence `host-rebuild`, in
  `host/appbox-update`): `podman pull`, `verify --key`, the second
  `app_running_in_box` check, `image=${pinned}` and `pull=false` in the temp
  ini, then `assemble create --replace`. Sequence `host-main` requires the
  is-an-app-open check before `rebuild_box` is called, and `host-upgrade`
  requires `app_running_in_box "${pkg}"` before `--only-upgrade`.
- **No verification bypass** in the image, hook, updater, installer or build
  workflow: `trusted=yes`, `--allow-unauthenticated`,
  `AllowInsecureRepositories`, `--insecure` (curl, and cosign's
  `--insecure-ignore-tlog`/`-sct`), `--allow-insecure-registry`,
  `--tls-verify=false`, `--no-check-certificate`, `curl -k`.
- **The init hook installs only and never fails** (`scripts/claude-desktop-sync`):
  no `upgrade`, `dist-upgrade`, `full-upgrade` or `--only-upgrade` outside
  comments and quoted text; no `set -e`; the last command is `exit 0`.
  distrobox-init runs with errexit, so a failing hook stops the box and every
  app in it.
- **The public keys exist and are public keys**: `cosign.pub` and
  `keys/ublue-os-toolboxes.pub` contain `-----BEGIN PUBLIC KEY-----`.

Sequences are line based: each pattern must appear on a code line (comments
ignored) on or after the line of the previous one. They prove the steps are
present and ordered. They do not prove the steps are correct; the tests and
the reviewer agent do that. When a file is rewritten so a step is spelled
differently, update the pattern in the same pull request and say so.

## repo-target.json

Keeps `gh` write commands on `Danathar/appbox`.

- In the governance docs listed in `requireFlagGlobs` (this file, the
  runbook, multi-agent, quality, review rubric, risk tiers, strategy,
  SECURITY-AI and reflections), every `gh pr|issue|release|workflow|label|secret|variable`
  write and `gh run rerun|cancel|delete` carries `-R Danathar/appbox` or
  `--repo Danathar/appbox` on the same logical line (a trailing backslash
  continues a line).
- In every scanned Markdown file and workflow, no write command may name
  another repository with `-R`/`--repo`, no `GH_REPO` may point at another
  repository, and no `gh repo set-default` may name one. Read-only commands
  and links to other repositories are fine.

Other Markdown (README, CONTRIBUTING, agent directions) is not held to the
`-R` rule yet; the README's command for starting a build by hand is written
for a person in a clone. A file can be added to `requireFlagGlobs` once it
complies.

## no-secrets.json

No private key or secret file in the tree. Fails on files named like
`cosign.key`, `*.key`, `.env`, `.env.*`, `id_rsa`, `id_ed25519`, `*.p12`,
`.netrc` and similar, and on any file containing a PEM private key header
(including cosign's `ENCRYPTED SIGSTORE PRIVATE KEY`) or a GitHub or
Anthropic token pattern. The message names the path only, never the content.
`hosts/example.env` and other `hosts/*.env` files are settings, not secrets,
and are not matched. If this fails on a real key: remove it, then rotate the
key (see [the runbook](../docs/ai-ops-runbook.md#a-leaked-secret)). An
encrypted cosign key with an empty password is not protected.

## Risk tiers

Not a JSON policy: the checker compares the tier table in
[docs/risk-tiers.md](../docs/risk-tiers.md) with
[`risk-config.json`](../risk-config.json) and fails when tier numbers, names,
paths, required commands or scrutiny differ. A path takes the highest tier it
matches; an unlisted path is Tier 1.

## The floor

Every agent pull request merges once checks pass, so a pull request that
edits only a policy JSON file could quietly switch a rule off. The checker
hard-codes a minimum (`FLOOR` in `scripts/check-policies.mjs`) and fails when
a policy drops below it:

- `requireTopLevelPermissions` stays true, `pinPattern` stays 40-hex,
  `trustedActionOwners` stays empty, `forbiddenRunExpressions` stays set, and
  `jobPermissionsSuffice` lists nothing but `build-appbox.yml`;
- `claude-desktop` stays a proprietary package, both image build files and
  the package list stay checked, the `build-signing`, `host-rebuild` and
  `image-no-proprietary` sequences, the init hook rule and both public keys
  stay;
- every Tier 2 path named in the brief (`host/**`, `hosts/**`,
  `distrobox.ini`, `ContainerFiles/**`, `scripts/appbox.sh`,
  `scripts/claude-desktop-sync`, `packages/**`, `keys/**`, `cosign.pub`,
  `.github/workflows/build-appbox.yml`, `.claude/settings.json`,
  `.claude/hooks/**`) stays in the highest tier of `risk-config.json`.

Lowering the floor means changing the script and its tests, which is a
visible change a reviewer can see. It is not a lock: an agent that edits the
script, the tests and the JSON together can still do it. That is what the
reviewer agent, the owner's `hold` label and the agent audit are for.

## What the checker does not defend against

It catches accidental omissions: a forgotten `permissions:` block, an
unpinned action, a refactor that drops `cosign sign` or moves the install of
a proprietary app into the image, an init hook that starts upgrading. It is
not a shell or YAML parser. It does not see through variables built at run
time, `eval`, generated scripts, or a package name assembled from parts. The
other layers are the tests (bats, e2e image build), the `test` required
check, the repository-scoped `GITHUB_TOKEN`, and the reviewer agent.
