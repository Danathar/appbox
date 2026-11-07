# Installing appbox on a machine

How to put a new machine on appbox: create the `apps` box, move existing app
data into it, and enroll the machine in automatic updates. Written so a person
or a Claude Code session can follow it start to finish on any machine.

Before starting, read:

- [`README.md`](../README.md): what the image, `distrobox.ini`, and timer do,
  and "Managing machines centrally".
- [`working-on-the-repo.md`](working-on-the-repo.md): caveats for changing
  the repo (`main` is live on every enrolled machine).
- Every `hosts/*.md`: records of machines already installed, including their
  lessons learned. Reuse those; don't rediscover them.

## Ground rules

- Run this from a Claude Code session started in the checkout as
  `APPBOX_OWNER_SESSION=1 claude` (the commands are at the top of
  [`new-machine-prompt.md`](new-machine-prompt.md)). Check before starting:
  `echo "${APPBOX_OWNER_SESSION:-}"` must print `1`. If it doesn't, stop and
  ask the owner to restart the session that way. The repo's guard hook
  refuses the machine-setup commands below (creating the box, `host/install`,
  running the update script) in any other session; see "The Bash guard" in
  [`AGENTS.md`](../AGENTS.md).
- `main` only takes pull requests, the owner's included. Never push to it;
  every repo change goes through a pull request (step 8 has the commands).

- Ask the owner before anything destructive: removing or replacing boxes,
  deleting data or launchers, changing other timers or services.
- If a box named `apps` already exists, stop and ask.
- Don't layer packages with rpm-ostree.
- Copy app data, never move it, until the owner confirms the migration.
- Leave old boxes and launchers in place until the owner says to remove them.
- Before running anything that can recreate a box, check yourself that its
  apps are not running. Don't rely on anyone's word.
- No em dashes in docs or commit messages.

## 1. Inventory (read only)

Report the findings before changing anything.

- **Machine:** hostname (`hostname -s`), OS and image
  (`rpm-ostree status --booted`, `/usr/share/ublue-os/image-info.json` on
  Universal Blue), CPU architecture (`uname -m`; the image is amd64 only),
  GPU (`lspci | grep -iE 'vga|3d|display'`), and whether it is a laptop that
  sleeps or a machine that is always on.
- **Tools:** podman, distrobox, git, and cosign. cosign can come from Homebrew
  (`brew install cosign`); the update script also looks at
  `/home/linuxbrew/.linuxbrew/bin/cosign`.
- **Existing boxes:** `distrobox list` and `podman ps -a`. For each: image,
  running or not, and its home directory. Custom homes are easy to miss; look
  for `--home` in `podman inspect -f '{{.Args}}' <box>`, or run
  `distrobox enter <box> -- sh -c 'echo $HOME'`.
- **Launchers:** every file in `~/.local/share/applications/` and the box it
  belongs to (its `Exec=` line).
- **Apps:** for each GUI app, the package and version inside its box, where
  its data lives (under that box's home), the data size, and whether it is
  running now.
- **Conflicts:** whether a box named `apps` exists, and whether
  `~/.config/<App>` already exists on the host for any app to migrate.
- **Other updaters:** `systemctl list-timers --all`,
  `systemctl --user list-timers --all`, and `/etc/uupd/config.json` if
  present. If uupd's distrobox module is enabled, it will also upgrade the
  `apps` box in place; report it, don't change it.

## 2. Plan the apps

For each GUI app found, propose one of these and wait for the owner's answer:

- **Already in the image** (Signal, Claude Desktop): migrate its data only.
- **Add to the image:** an Ubuntu package via `packages/appbox.packages`, or a
  vendor apt repo in `scripts/appbox.sh` following the Signal block (pin the
  key fingerprint with `fetch_key`, and follow the vendor's current install
  instructions, not memory). Only if its license allows redistribution in a
  public image.
- **Proprietary:** add the vendor repo to the image and install it at box
  start from an init hook like `scripts/claude-desktop-sync`. Never bake it
  into the image.
- **Better elsewhere:** as a Flatpak, or left where it is. Say why.

Find each app's real `.desktop` file with
`dpkg -L <package> | grep '\.desktop$'`; don't guess. Signal's repo is amd64
only.

## 3. Repo changes (if any)

Follow [`working-on-the-repo.md`](working-on-the-repo.md). In short:

- Apps added to the image are shared by every machine. That is fine; a
  machine only gets launchers for what its ini exports.
- Keep the shared `distrobox.ini` GPU-neutral (Mesa in the image covers Intel
  and AMD). If this machine needs NVIDIA (`nvidia=true`) or different apps,
  give it its own `hosts/<hostname>.ini` and set `APPBOX_INI` in
  `hosts/<hostname>.env`.
- Each change is a pull request (commands in step 8). Merge image changes
  first, wait for the build on `main` to go green
  (`gh run list -R Danathar/appbox --workflow build-appbox --branch main --limit 1`),
  and check the signature
  (`cosign verify --key cosign.pub ghcr.io/danathar/appbox:latest`) before
  merging ini changes that depend on them.

## 4. Clone and create the box

```sh
git clone https://github.com/Danathar/appbox ~/claude/appbox   # default path
distrobox assemble create --file ~/claude/appbox/distrobox.ini  # or this machine's ini
```

The repo is public, so cloning needs no login. Opening pull requests does (`gh auth login`).
A different checkout path works; `host/install` (step 7) handles it.

**Do not launch any app from the new box yet.** Launching Signal before its
data is in place creates a fresh, unlinked profile.

## 5. Migrate app data

For each app being migrated:

1. Ask the owner to fully quit it in the old box (tray > Quit, not just
   closing the window).
2. Check for yourself: no process running (`pgrep -ax <name>`) and no
   `SingletonLock` in the old profile directory.
3. `distrobox stop <old-box>` (stop only, don't remove).
4. If `~/.config/<App>` already exists on the host, stop and ask.
5. Copy: `rsync -aHAX <old-home>/.config/<App> ~/.config/`.

Also check:

- The image's version of each app is the same as or newer than the old one.
  Signal cannot open a database written by a newer version.
- Keyring backends. Signal's `config.json` names its `safeStorageBackend`
  (for example `kwallet6` or `gnome-libsecret`). The new box reaches the same
  host keyring over the session bus, as a default distrobox does.
- Two copies of a linked Signal device must never both run. Once the new one
  is in use, warn the owner not to open the old launcher.

## 6. Test with the owner

1. The owner opens each app from the app grid (the "(on apps)" entries) and
   confirms it works: Signal linked with its history, Claude Desktop logged
   in, other apps as appropriate.
2. The owner fully quits everything. Check for yourself that nothing is
   running in the box.
3. Recreate through the real update path:
   `~/claude/appbox/host/appbox-update --force`.
4. The owner opens the apps again and confirms nothing was lost.

To test the "skip while an app is running" path, use the throwaway-ini and
`prctl` dummy-process method in
[`working-on-the-repo.md`](working-on-the-repo.md#testing-changes-to-the-update-script-safely).

## 7. Enroll in automatic updates

Only after step 6 passes:

```sh
~/claude/appbox/host/install
```

It links the units, enables the timer, and prints the effective settings
(`--show-config`). Check them. Then run the full path once under systemd,
which is how it runs unattended (different PATH, no terminal), after
checking that the apps are closed:

```sh
systemd-run --user --wait --collect ~/claude/appbox/host/appbox-update --force
```

### Laptops and always-on machines

- **Laptop that sleeps:** the timer's 04:30 run happens as soon as the lid
  opens. The script waits for the network and retries, so nothing is needed.
- **Always on:** the timer runs every night. An app that never quits is never
  upgraded or rebuilt, by design. The owner gets "Signal 8.x is ready" once per
  new version, "Weekly apps update is waiting" once when a rebuild is first
  skipped, and "apps box is N days old" on every skipped run once the box is
  twice its maximum age (14 days by default). Each tells them to quit the app
  and run `systemctl --user start appbox-update`. Tell the owner whether that
  will be routine on this machine and suggest options (quitting Signal at
  night, or a different `APPBOX_MAX_AGE_DAYS`), without changing the design.

See "How updates reach you" in the README for the full table of what happens
and which notification goes with it.

## 8. Record the machine

- `hosts/<hostname>.env`: start from `hosts/example.env`. List the settings
  even if they are defaults, so the machine's configuration is visible.
- `hosts/<hostname>.md`: same shape as the existing records. Cover host
  facts, what was there before, what was done, current configuration,
  leftovers kept on purpose, and anything new learned.
- Add the machine to the "Machines so far" line in `README.md`.
- Open a pull request with these files. `main` takes no direct pushes. Write
  the description from `.github/pull_request_template.md` (Tier 2, because it
  touches `hosts/`; the machine impact; the checks you ran) into a file, and
  pass that file, because `--fill` would skip the template:

  ```sh
  cd ~/claude/appbox
  git switch main && git pull --ff-only
  git switch -c hosts/<hostname>
  git add hosts/<hostname>.env hosts/<hostname>.md README.md
  git commit -s -m "Record <hostname>"
  git push -u origin hosts/<hostname>
  gh pr create -R Danathar/appbox --title "Record <hostname>" --body-file <description file>
  gh pr checks -R Danathar/appbox --watch    # about 10 minutes, mostly the image build test
  ```

  If a check fails, fix it on the branch and push again. When the checks are
  green, **don't merge it yourself** (`AGENTS.md`: agents never merge their
  own pull requests). Give the owner the link; the owner, or Hive's
  serialized merge lane, merges it. Once it has merged, put the checkout back
  on `main`, because the timer's self-update follows whatever branch is
  checked out:

  ```sh
  git switch main && git pull --ff-only
  ```

## Report

When done, give the owner:

- the box status and the timer status (`systemctl --user list-timers appbox-update.timer`)
- each app's result: works, data persisted across a recreate, or what failed
- leftovers for them to clean up (old boxes, launchers, data copies)
- anything that didn't work
