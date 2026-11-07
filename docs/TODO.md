# To do

Follow-ups noted while setting up appbox (2026-11-07), roughly in priority
order within each section. Tick items off or delete them as they are done.

## Security

- [ ] **Protect `main`.** Every enrolled machine runs whatever is on `main`
  (the update script self-updates), so `main` is effectively a remote-code
  path onto those machines. In Settings > Branches (or a ruleset): block force
  pushes and branch deletion, and require the `build-appbox` check to pass.
  Requiring pull requests is stronger, but means no more direct pushes from
  any machine; decide whether that is worth it.

- [ ] **Require and verify signed commits.** Branch protection stops other
  people; this stops a stolen GitHub token too. Sign commits (SSH signing is
  simplest: `git config --global gpg.format ssh`, `user.signingkey`,
  `commit.gpgsign true`), require signed commits on `main`, and have
  `appbox-update` refuse to fast-forward to an unsigned or unknown-signer
  commit (`git merge --ff-only --verify-signatures`, or
  `git verify-commit` with `gpg.ssh.allowedSignersFile`). The allowed-signers
  file must live **outside** the repo on each machine, or a malicious commit
  could just replace it.

- [ ] **Back up the cosign private key.** It exists only at
  `~/.config/appbox-signing/cosign.key` on aurora-think (and in the
  write-only `SIGNING_SECRET`). Put a copy in a password manager. If it is
  lost or leaked: generate a new pair, `gh secret set SIGNING_SECRET`,
  commit the new `cosign.pub`, and let CI re-sign. Machines pick up the new
  public key through self-update.

- [ ] **Consider keyless signing instead.** cosign can sign with the
  workflow's GitHub OIDC identity, so there is no private key to store, back
  up, or leak. Verification then uses
  `--certificate-identity-regexp` and `--certificate-oidc-issuer` instead of
  `--key`. Would replace `cosign.pub`, `SIGNING_SECRET`, and the verify steps
  in the workflow and `host/appbox-update`.

- [ ] **Make podman enforce the signature too.** Today only
  `host/appbox-update` checks it. A manual `distrobox assemble create`
  pulls `:latest` unchecked. Adding a sigstore policy for
  `ghcr.io/danathar/appbox` (`policy.json` plus a `registries.d` entry with
  `use-sigstore-attachments: true`) makes every pull verify. Careful: a user
  `~/.config/containers/policy.json` replaces the system one entirely, so it
  has to start as a copy of `/etc/containers/policy.json`.

- [ ] **aurora-think: rebase the OS to a signed image ref.** It boots
  `ostree-unverified-registry:ghcr.io/ublue-os/aurora-dx:stable`, so OS updates
  are not signature-checked. Not part of this repo, but found during setup.
  Check what ublue currently recommends (likely
  `rpm-ostree rebase ostree-image-signed:docker://ghcr.io/ublue-os/aurora-dx:stable`
  or the `bootc switch --enforce-container-sigpolicy` equivalent). Check the
  desktop too.

## Maintenance

- [ ] **Pick one dependency bot.** Both Dependabot (`.github/dependabot.yml`)
  and Renovate (`renovate.json`) are active and open duplicate PRs for the
  same action bumps. Keep one (Renovate also handles digests and can
  auto-merge when CI passes), delete the other's config, and close its PRs.

- [ ] **Merge or close the open bot PRs** (#2, #6, and the Renovate ones).

- [ ] **Node 20 deprecation.** CI warns that `redhat-actions/buildah-build`
  and `redhat-actions/push-to-registry` target Node 20, which GitHub is
  retiring. Check for newer releases, or replace both with plain `buildah`
  and `podman push` commands in `run:` steps.

- [ ] **Shrink the weekly download.** The whole app layer (Signal, Claude's
  dependencies, qemu) is one `RUN`, so every daily build changes about 1 GB
  and each weekly recreate downloads all of it. Options: split stable
  dependencies and Signal into separate layers, push with
  `--compression-format=zstd:chunked` (ubuntu-toolbox does), or rechunk with
  `chunkah` like ublue.

- [ ] **Remove leftover template files.** `CODE_OF_CONDUCT.md` still names
  ublue's maintainers. `LICENSE` is the template's Apache-2.0; keep it only if
  that is the license you want.

## Reliability and testing

- [ ] **Smoke-test the image in CI before pushing.** For example: check that
  every `.desktop` path in `distrobox.ini` (and `hosts/*.ini`) exists in the
  image, run `signal-desktop --version`, and run `claude-desktop-sync` in a
  throwaway container to prove Claude Desktop still installs. That throwaway
  install is never pushed, so it doesn't conflict with the licensing rule.
  This catches package and launcher renames before they reach a machine.

- [ ] **Notify on update failure.** If the service fails for good (network or
  verification failures after its retries), only the journal says so. An
  `OnFailure=` unit that runs `notify-send` would surface it.

- [ ] **Back up Signal data.** Recreates keep `~/.config/Signal`, but a lost
  or wiped disk means re-linking with no history. Decide whether it belongs
  in your normal backups (it is about 5 GB and holds the database key's
  ciphertext; the key itself is in KWallet).

- [ ] **Box name prefix gotcha.** `distrobox rm apps` removes every launcher
  in `~/.local/share/applications/` whose name starts with `apps`, not just
  `apps-*`. Harmless today; worth knowing before naming other boxes or
  launchers `apps...`, or rename the box to something more distinctive.

## Rollout

- [ ] **Migrate the desktop** with
  [`migrate-desktop-prompt.md`](migrate-desktop-prompt.md). It is always on
  and Signal probably never quits there, so watch whether the 14-day
  notification becomes routine.

- [ ] **Try Cowork once (optional).** Its host prerequisites are verified, but
  a real task has never run, so the VM bundle has never been downloaded.
  Only matters if you start using it.
