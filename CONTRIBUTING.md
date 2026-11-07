# Contributing

Thanks for helping. appbox is a CI-built distrobox image
(`ghcr.io/danathar/appbox`, with Signal baked in and Claude Desktop installed
at box start) plus `host/appbox-update`, the systemd user timer that keeps each
machine's `apps` box current. See [README.md](README.md) for how it works.
Contributions are licensed Apache-2.0, like the rest of the repo.

The most important thing to know before changing anything: **`main` is live.**
Every enrolled machine fast-forwards its checkout to `main` on its next timer
run and runs what it finds. There is no staging step, so a merge to `main` is a
deployment. [docs/working-on-the-repo.md](docs/working-on-the-repo.md) is the
full guide to changing the repo safely; read it before your first change. This
file is the short version.

## What a merge deploys

| You change                                             | Reaches machines                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| The image sources (listed below)                       | CI builds a new image; each machine uses it at its next weekly recreate |
| `host/appbox-update`, `cosign.pub`                     | Next timer run on every machine, through self-update                    |
| `distrobox.ini`, `hosts/*.ini`, `hosts/<hostname>.env` | Next timer run; ini changes take effect at the next recreate            |
| `host/*.service`, `host/*.timer`                       | Only after each machine runs `systemctl --user daemon-reload`           |
| `*.md`, `docs/`, `tests/`                              | Nothing to deploy                                                       |

The image sources are `ContainerFiles/`, `scripts/appbox.sh`,
`scripts/claude-desktop-sync`, `packages/`, `keys/` (the base image's
signing key) and `.github/workflows/build-appbox.yml`. `cosign.pub` is the
key every machine checks the image signature against before a rebuild, so
changing it without also rotating the CI signing secret stops every machine
from rebuilding. Re-running `host/install` also does the `daemon-reload`.

Two ordering rules follow from this:

- If an ini change depends on something new in the image (a new app to
  export), merge the image change first, wait for the `build-appbox` run on
  `main` to go green, and only then merge the ini change. Otherwise a machine
  can recreate with the new ini and the old image, and the export fails.
- A change to a unit file is not live until each machine reloads systemd.
  Say so in the PR so the owner knows to run it on every machine.

## Ground rules

- **Never bake Claude Desktop, or any other proprietary app, into the image.**
  The image is public. Add the vendor's apt repo and install at box start from
  an init hook, the way `scripts/claude-desktop-sync` does. Only apps whose
  licence allows redistribution (Signal is AGPL-3.0) are baked in.
- **An open app is never touched.** Init hooks install only, never upgrade,
  and always exit 0. Upgrades happen in `host/appbox-update`, only for closed
  apps listed in `guarded_apps`.
- **Do not test `host/appbox-update` against a real `apps` box** while Signal
  or Claude is open. Use the throwaway ini method in
  [docs/working-on-the-repo.md](docs/working-on-the-repo.md#testing-changes-to-the-update-script-safely).
- **Never force-push or rewrite `main`.** Self-update only fast-forwards, so a
  rewrite silently stops every machine from updating.
- Keep the shared `distrobox.ini` GPU-neutral. Per-machine needs go in
  `hosts/<hostname>.ini` and `hosts/<hostname>.env`.
- Write prose (docs, commit messages, PR text) without em dashes. Use commas,
  colons, parentheses, or a new sentence.

## Running the checks locally

CI (`.github/workflows/ci.yml`) runs all of these on every pull request, but
running them first saves a round trip.

```sh
# Shell scripts: shellcheck, in a container so nothing is installed on the host
podman run --rm -v "$PWD:/mnt:ro,z" -w /mnt docker.io/koalaman/shellcheck:stable \
    host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync

# Unit tests for the shell scripts (bats-core)
bats tests/unit

# Node tooling and the Claude Code hook tests (Node built-ins only, no npm install)
node --test scripts/tests .claude/hooks/tests
```

If you changed the image (`ContainerFiles/`, `scripts/appbox.sh`,
`scripts/claude-desktop-sync`, `packages/`), also build it. The end-to-end
check in `tests/e2e/` builds the image and checks what ends up in it; a plain
local build is
`podman build -f ContainerFiles/appbox -t localhost/appbox:test .`.

For settings or ini changes, `host/appbox-update --show-config` prints what a
machine will use (with `APPBOX_SELF_UPDATE=0` and the variables set by hand if
you are not on that machine).

Add or update a bats test for each behaviour change in `host/` or `scripts/`,
and update the README or `docs/` when user-visible behaviour or configuration
changes.

## Risk tiers and how changes merge

appbox is worked on by an autonomous hive of AI agents as well as by people.
There is no human-merge gate on any tier: a hive agent's pull request merges
automatically once the required checks pass, Tier 2 included. The tiers set
how much scrutiny a change gets before that point. The full list of paths is
in [docs/risk-tiers.md](docs/risk-tiers.md); in short:

- **Tier 0:** docs, tests, `.claude/memory/`, `docs/reflections/`. Normal
  review.
- **Tier 1:** CI and tooling: `.github/workflows/` (except the image build),
  `scripts/*.mjs`, `policies/`, and `.claude/` configuration. Normal review,
  and CI must be green.
- **Tier 2 (highest scrutiny):** anything machines run or the image
  contains: `host/`, `hosts/`, `distrobox.ini`, the image sources above,
  `cosign.pub`, and the agent boundary (`.claude/settings.json`,
  `.claude/hooks/`).

A Tier 2 pull request must:

- be reviewed by the reviewer agent before it merges;
- come with tests that cover the change (a bats test in `tests/unit` for a
  script change, the image check in `tests/e2e/` for an image change);
- state its machine impact in the description: whether machines need a
  `systemctl --user daemon-reload`, and, for an ini change that depends on the
  image, that the image change is already merged and its build is green.

The owner's brake is the `hold` label: a pull request carrying it does not
merge until the label is removed. AI agents should read [AGENTS.md](AGENTS.md)
for the rules that apply to them.

## Commits and pull requests

- **Sign off every commit** with `git commit -s`. This adds a
  `Signed-off-by:` line (the [Developer Certificate of Origin](https://developercertificate.org/)),
  and a pull request with an unsigned commit will not be merged.
- One logical change per pull request. Fill in the pull request template:
  which tier and paths you touched, the commands you ran, and what you could
  not verify.
- If an AI tool helped, say so in the pull request description.
- To work from an enrolled machine, see
  [Editing on an enrolled machine](docs/working-on-the-repo.md#editing-on-an-enrolled-machine):
  commit and push promptly, or that machine silently stops following `main`.

## Reporting bugs and requesting features

Use the issue forms. For a bug, include the `journalctl --user -u appbox-update`
excerpt and the `host/appbox-update --show-config` output from the affected
machine; the form asks for the rest.

**Security problems do not go in public issues.** Report them privately
through GitHub's private vulnerability reporting: the **Security** tab, then
**Report a vulnerability**. Anything that could let someone run code on an
enrolled machine (through `main`, the image, or its signature check) counts.
