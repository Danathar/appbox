# Fake a running app with prctl, not a renamed binary

**Date:** 2026-11-07
**Wrong:** faking an open Signal or Claude for a test by copying a binary
such as `sleep` to the name `signal-desktop` and running it. On Ubuntu 26.04
coreutils is a single multicall binary that decides what to be from its own
name, so a renamed copy refuses to run and the test silently has no "running
app".
**Right:** set the process name with `prctl(PR_SET_NAME)` (option 15), which
is what `pgrep -x` matches:
`podman exec -d apps python3 -c 'import ctypes,time; ctypes.CDLL(None).prctl(15, b"signal-desktop", 0, 0, 0); time.sleep(120)'`.
That command runs inside the owner's real box, so it is part of the owner's
test plan, not something an agent runs. In bats tests, stub `pgrep` and the
`/proc` checks instead.
**Why it matters:** a fake that never starts makes every "app is open" test
pass for the wrong reason: the script sees no app and proceeds to rebuild or
upgrade, which is exactly what the test meant to rule out.
**Evidence:** `hosts/aurora-think.md`, "Lessons learned" (last-but-one
bullet); `docs/working-on-the-repo.md`, "Testing changes to the update script
safely", second bullet.
