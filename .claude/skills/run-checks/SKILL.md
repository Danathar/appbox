---
name: run-checks
description: Run appbox's lint and tests (shellcheck, bats, node --test, actionlint) before committing or opening a pull request, and report the results.
---

# run-checks

Run from the repo root of your own clone, never from the checkout an enrolled
machine's timer runs from (`~/claude/appbox` on an enrolled machine).

```sh
shellcheck host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync
bats tests/unit
node --test scripts/tests .claude/hooks/tests
actionlint                         # when .github/workflows/ changed
jq . .claude/settings.json         # when the settings changed
git diff --name-only origin/main...HEAD | xargs grep -nP '\x{2014}'   # no em dashes (expect no output)
```

Without a local shellcheck, use the container from
`docs/working-on-the-repo.md`:
`podman run --rm -v "$PWD:/mnt:ro,z" -w /mnt docker.io/koalaman/shellcheck:stable host/appbox-update host/install scripts/appbox.sh scripts/claude-desktop-sync`.

When the change touches the image (`ContainerFiles/`, `scripts/appbox.sh`,
`scripts/claude-desktop-sync`, `packages/`, `keys/`), the end-to-end checks in
`tests/e2e/` matter most; CI runs them against a fresh build. A local build is
`podman build -f ContainerFiles/appbox -t localhost/appbox:test .`, always with
the `localhost/appbox:test` tag.

Report the exact commands and what each printed, in the PR body. If a tool is
missing (`bats` often is), say so and rely on CI. Never stand in for a missing
test by running `host/appbox-update` for real; the guard hook refuses it
anyway, and `--show-config` is the only run that is safe.

CI's aggregate job `test` in `.github/workflows/ci.yml` is the required check;
a PR merges once it is green, so a check you skip locally still has to pass
there.
