# `func && ...` and `if func` turn errexit off inside func

**Date:** 2026-11-07
**Wrong:** an early draft of the update script called the rebuild as
`rebuild_box && ...` to tell "rebuilt" from "skipped". Bash ignores `errexit`
for every command inside a function called as part of `&&`, `||`, `if` or
`while`, so a failed `podman pull` or `cosign verify` inside `rebuild_box`
would no longer abort the run. It would carry on and delete the box with
nothing verified to recreate it from.
**Right:** a function that must abort on failure is called as a plain
statement. `rebuild_box` reports a skipped rebuild by setting
`rebuild_skipped=1` and returning 0, and the caller reads the variable:
`rebuild_box` then `[ "${rebuild_skipped}" -eq 1 ] || exit 0`. Use the same
shape for any new function that reports more than success or failure.
**Why it matters:** the whole safety of a rebuild is that the pull and the
signature check happen, and can stop the run, before the old box is deleted.
The bug is silent: nothing fails until a real pull fails on a machine.
**Evidence:** `git show 3f0a896:host/appbox-update` lines 186-191 (the
comment and `rebuild_skipped=0`), 210 (`rebuild_skipped=1`), 290-292 (the
caller); commit `972558d` ("Report a skipped rebuild through a flag instead
of a return code, so errexit stays on inside rebuild_box"); the lesson in
`hosts/aurora-think.md` ("Caught in review, before it ran");
`docs/working-on-the-repo.md`, last bullet of "Testing changes to the update
script safely".
