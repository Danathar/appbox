# Prompt: migrate the desktop onto appbox

Paste everything below the line into Claude Code on the desktop.

---

I want to move the GUI apps on this machine (my always-on desktop, AMD GPU)
out of whatever distroboxes they live in now and onto my CI-built appbox image,
the same way my laptop was migrated. I use podman, and gh is authenticated as
Danathar.

## Context

- Repo: https://github.com/Danathar/appbox. Clone it to `~/claude/appbox`
  (the systemd service expects that path; if you use another, edit
  `ExecStart` in `host/appbox-update.service`).
- Image: `ghcr.io/danathar/appbox:latest` (public, cosign-signed, built daily).
  Ubuntu 26.04 base from `ghcr.io/ublue-os/ubuntu-toolbox`, Signal Desktop
  baked in, Claude Desktop installed at box start by an init hook because it
  is proprietary and must not be baked into the public image.
- Read these first, fully, before doing anything:
  - `README.md`: how the repo, image, `distrobox.ini`, and timer work.
  - `docs/hosts/aurora-think.md`: exactly what was done on the laptop,
    including the lessons-learned list. Reuse what it learned; don't
    rediscover it.
- The laptop's `apps` box is the reference: one box named `apps`, normal
  `$HOME`, app data in `~/.config/<App>`, launchers exported as
  `apps-*.desktop`, and the `appbox-update` timer.

## Steps

1. **Inventory, read only, then report to me before changing anything.**
   - OS and image (`rpm-ostree status --booted`, `/usr/share/ublue-os/image-info.json`),
     GPU (`lspci | grep -iE 'vga|3d|display'`), podman, distrobox, and whether
     `cosign` is installed (Homebrew is fine; the update script also checks
     `/home/linuxbrew/.linuxbrew/bin/cosign`).
   - Every box: `distrobox list`, `podman ps -a`. For each, its image, whether
     it is running, and its home directory. Custom homes are easy to miss:
     look for `--home` in the box entrypoint args
     (`podman inspect -f '{{.Args}}' <box>`), or run `echo $HOME` inside it.
   - Every exported launcher in `~/.local/share/applications/` and which box
     it belongs to (`Exec=` line).
   - For each GUI app: the package and version inside its box, where its data
     lives (under that box's home), how big the data is, and whether it is
     running now.
   - Whether a box named `apps` already exists. If it does, stop and ask me.
   - `systemctl list-timers --all` and `systemctl --user list-timers --all`,
     plus `/etc/uupd/config.json`. Check whether uupd's distrobox module is
     enabled. If it is, it will also `distrobox upgrade` the `apps` box;
     tell me that, but don't change it.

2. **Propose a plan per app and wait for my answer.** For each GUI app found,
   suggest one of:
   - Already in the image (Signal, Claude Desktop): just migrate data.
   - Add to the image: distro package via `packages/appbox.packages`, or a
     vendor apt repo in `scripts/appbox.sh` following the Signal block (check
     the key fingerprint with `fetch_key`; follow the vendor's *current*
     install instructions, not memory). Only if the license allows
     redistribution in a public image.
   - Proprietary: add the apt repo in the image, install it from an init hook
     like `scripts/claude-desktop-sync`. Never bake it into the image.
   - Better as a Flatpak, or better left where it is. Say why.
   Find each app's real `.desktop` file (`dpkg -L <pkg> | grep '\.desktop$'`)
   for `exported_apps`. Don't guess. Note that Signal's repo is amd64 only.

3. **Repo changes, if any.** Make them in the repo, push, run
   `gh run watch` until green, and confirm with
   `cosign verify --key cosign.pub ghcr.io/danathar/appbox:latest`. Keep
   `distrobox.ini` GPU-neutral (Mesa in the image covers AMD and Intel; only
   NVIDIA needs `nvidia=true`). The laptop pulls the same image and ini, so
   don't add anything that only works on this machine. Commit prose without
   em dashes.

4. **Create the box.** `distrobox assemble create --file ~/claude/appbox/distrobox.ini`.
   Don't launch any app from it yet. Launching Signal before its data is in
   place creates a fresh, unlinked profile.

5. **Migrate data, copy not move.** Ask me to fully quit each app in its old
   box (tray > Quit). Confirm no processes and no `SingletonLock` in the old
   profile, `distrobox stop` the old box (stop only, don't remove), then
   `rsync -aHAX <old-home>/.config/<App> ~/.config/`. If `~/.config/<App>`
   already exists, stop and ask me. Make sure the image's Signal version is
   the same as or newer than the old one; Signal can't open a database written
   by a newer version. Note each app's keyring backend (Signal's
   `config.json` has `safeStorageBackend`). The new box must reach the same
   keyring over the session bus, which a default distrobox does.

6. **Test with me.** I launch each app from the app grid ("(on apps)"
   entries) and confirm it works: Signal still linked with history, Claude
   logged in. Then I quit everything and you run
   `~/claude/appbox/host/appbox-update --force` to recreate the box through
   the real update path. I launch again and confirm nothing was lost.
   Before running anything that can recreate the box, check what is running
   yourself; don't rely on my answer alone.
   To test the "skip while running" path without risk, use a throwaway ini
   with a nonexistent image (so a failed check stops at the pull) and a
   dummy process named via `prctl(PR_SET_NAME)`, as described in the laptop
   record.

7. **Install the timer** (only after step 6 passes):
   ```sh
   mkdir -p ~/.config/systemd/user
   ln -sf ~/claude/appbox/host/appbox-update.service ~/.config/systemd/user/
   ln -sf ~/claude/appbox/host/appbox-update.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now appbox-update.timer
   systemctl --user list-timers
   ```
   Then run the full path once under systemd, since that is how it runs
   unattended (different PATH, no terminal):
   `systemd-run --user --wait --collect ~/claude/appbox/host/appbox-update --force`.

8. **Always-on caveat.** This machine is on all the time, so the timer fires
   at 04:30 every night. If Signal is always open, every run skips. The script
   sends a desktop notification once the box is 14 days old, asking me to quit
   the apps and run `systemctl --user start appbox-update`. Tell me plainly
   whether that will be the normal case here, and suggest options (for
   example, quitting Signal at night) without changing the design yourself.

9. **Write `docs/hosts/<hostname>.md`** in the repo, in the same shape as
   `docs/hosts/aurora-think.md`: host facts, what was there before, what was
   done, current configuration, leftovers kept on purpose, and anything new
   learned. Commit and push it.

## Ground rules

- Ask me before anything destructive on the host: removing or replacing
  boxes, deleting data or launchers, changing other timers.
- Don't layer anything with rpm-ostree.
- Copy app data; never move it until I say the migration is done.
- Old boxes and launchers stay until I say to remove them. Warn me not to
  launch an old Signal once the new one is in use.
- No em dashes in README, docs, or commit messages.

When done, give me: the box status, the timer status
(`systemctl --user list-timers`), each app's result (works, data persisted
across a recreate, or what failed), what is left over for me to clean up,
and anything that didn't work.
