# Correction memory

One file per correction: a mistake an agent made or nearly made in this
repository (or one the repo's own history shows a person made), the rule that
prevents it, and the evidence. The conversation that produced a mistake is
gone by the next session; these files are what is left.

**Host rule.** `main` is live on every enrolled machine. Never run
`host/appbox-update` (other than `--show-config`) or `host/install` on a real
machine, never remove, stop or recreate a box, and never touch an open app.
`.claude/hooks/guard-bash.mjs` enforces this. Every `gh` command passes
`-R Danathar/appbox`.

## What goes here

- Something that went wrong, or came within one step of it, that is easy to
  repeat and hard to see from the code alone.
- Not here: standing rules for all work (those are in
  [AGENTS.md](../../AGENTS.md)), what is in flight right now
  ([../session-summary.md](../session-summary.md)), and patterns in how the
  work goes ([../../docs/reflections/](../../docs/reflections/)). A correction
  that hardens into a standing rule is promoted to AGENTS.md; the entry stays
  as the reason behind the rule.

## Format

`<kebab-case-topic>.md`, one correction per file, in this shape:

```markdown
# <short title>

**Date:** YYYY-MM-DD (when it was recorded)
**Wrong:** what was done or assumed
**Right:** what is true, and what to do
**Why it matters:** the consequence of repeating it
**Evidence:** commit, PR or file:line that shows it
```

Evidence must be something a reader can open. A claim that cannot be checked
against a commit, a PR or a file does not get an entry. Line numbers name the
commit they were read at (`git show 3f0a896:host/appbox-update`), because they
drift; re-check them before relying on an entry.

## When to add and retire

- Add an entry in the same PR that fixes the mistake, or at the end of the
  session in which it was caught. Check the index first and extend an
  existing entry rather than adding a near-duplicate.
- If an entry stops being true, rewrite or delete it in the PR that makes it
  untrue. A stale correction is worse than none.
- Add every new file to the index below.

## Index

| Entry                                                                 | One line                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [errexit-off-inside-if-func](errexit-off-inside-if-func.md)           | `func && ...` or `if func` disables errexit inside func; `rebuild_box` reports through a variable  |
| [fake-running-app-with-prctl](fake-running-app-with-prctl.md)         | Ubuntu 26.04 coreutils refuses to run renamed; fake an open app with `prctl(PR_SET_NAME)`          |
| [closed-window-is-still-open](closed-window-is-still-open.md)         | Closing the window leaves Signal and Claude in the tray; check processes yourself                  |
| [init-hook-installs-only](init-hook-installs-only.md)                 | The box-start hook once upgraded under a starting app; it installs only, and Claude is never baked |
| [unit-changes-need-daemon-reload](unit-changes-need-daemon-reload.md) | Self-update pulls changed units but systemd keeps the old ones until daemon-reload                 |
