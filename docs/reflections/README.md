# Reflections

A reflection is a dated, short account of how a piece of work on appbox
actually went, and what to do differently next time. It is for patterns in
how the work goes, not for facts about the code (those belong in the code,
the README or `docs/working-on-the-repo.md`).

Because agent pull requests here merge without a human reading them
([risk tiers](../risk-tiers.md)), the lessons that matter most are about the
gate: what a check missed, what a review caught that no check did, and which
invariant turned out to have no test.

## Where things go

| Place                        | Holds                                    | Lifetime                 |
| ---------------------------- | ---------------------------------------- | ------------------------ |
| `AGENTS.md`, `CLAUDE.md`     | standing rules                           | durable                  |
| `.claude/memory/`            | one specific mistake and the rule for it | until no longer true     |
| `.claude/session-summary.md` | what is in flight now                    | overwritten each session |
| `hosts/<hostname>.md`        | what happened on one machine             | durable                  |
| this directory               | recurring patterns in how the work goes  | dated, kept              |

Example of the split: "`rebuild_box && ...` turns off errexit inside the
function, so a failed signature check would not abort" is a correction
(memory). "Policies written from a template assumed a human merge gate this
repository does not have" is a reflection.

## When to write one

- After a pull request where review or CI found something the author's own
  checks missed.
- After a revert, a bad image, or a machine that stopped updating.
- When the same kind of problem has come up twice.
- After onboarding work that others will repeat on another repository.

Do not write one for routine work that went as planned.

## Format

File name `YYYY-MM-DD-<topic>.md`, with these sections:

```markdown
# <title>

**Date:** YYYY-MM-DD
**Context:** which pull requests, issues or commits this is about

## What happened
Observed events only, each with a pull request, commit or file reference.

## What it shows
The pattern, stated as narrowly as the evidence allows.

## What to do next time
Concrete practices. If one hardens into a standing rule, move it to AGENTS.md.
```

Rules: no event that cannot be traced to a pull request, commit or file;
mark guesses as `[INFERENCE]`; link to the evidence instead of retelling it;
amend or delete an entry that later proves wrong. Pull requests and issues in
other repositories are written `Owner/repo#N`. No em dashes.

## Index

| Entry                                                       | Subject                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [2026-11-07-acmm-onboarding](2026-11-07-acmm-onboarding.md) | Onboarding appbox to the hive in one pass, and what transferred from earlier repositories |
