# A closed window is still an open app

**Date:** 2026-11-07
**Wrong:** treating "the user closed the Signal (or Claude) window" as "the
app is closed". Both keep running in the system tray after the window closes.
**Right:** an app is closed only after tray > Quit, and only a check of the
processes says so: `pgrep -ax 'claude-desktop|signal-desktop'`, and for a
data migration also no `SingletonLock` in the profile directory. Never take
anyone's word for it, including an earlier message in the same session.
**Why it matters:** the update script refuses to rebuild or upgrade an open
app, but a person or agent who believes the app is closed may run a recreate
by hand (`distrobox assemble create --replace`, `host/appbox-update --force`)
and cut Signal off mid-write. Copying Signal's data while it runs can copy a
half-written database.
**Evidence:** `README.md` lines 89-91 at `3f0a896` ("closing the window
leaves it running in the tray, which counts as open"); `docs/install.md`
step 5 ("tray > Quit, not just closing the window", then check for yourself);
`docs/working-on-the-repo.md`, "Testing changes to the update script safely",
first paragraph.
