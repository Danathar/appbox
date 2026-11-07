# Unit file changes do not take effect through self-update

**Date:** 2026-11-07
**Wrong:** assuming that a merged change to `host/appbox-update.service` or
`host/appbox-update.timer` is live on every machine after its next timer
run, like a change to the script is. Self-update pulls the new file into the
checkout (the units in `~/.config/systemd/user/` are symlinks to it), but
systemd keeps the old definition loaded.
**Right:** a unit change needs `systemctl --user daemon-reload` on each
machine (re-running `host/install` does it). Say so in the PR's machine
impact, and in the owner's follow-up list. Agents do not run daemon-reload
themselves: on a machine whose checkout holds unmerged edits it would load
those, and the guard hook refuses it.
**Why it matters:** the change looks deployed (the file on disk is new) while
the old schedule or `ExecStart` keeps running, possibly for weeks, and
nothing in the journal says so.
**Evidence:** `docs/working-on-the-repo.md`, the "What a push does" table
(row `host/*.service`, `host/*.timer`); `README.md` line 160 at `3f0a896`;
`host/install` (the `systemctl --user daemon-reload` line); `CLAUDE.md`.
