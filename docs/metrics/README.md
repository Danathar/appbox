# Published metrics

Dated, committed readings of the PR metrics defined in
[`docs/metrics.md`](../metrics.md). The repository is public, so these files
are the public record of how its pull requests are going. Each file is left
exactly as it was read. For current values, run the script or open the
latest `pr-metrics` artifact of the
[weekly workflow](https://github.com/Danathar/appbox/actions/workflows/pr-metrics.yml).

| date       | snapshot                    | input                                        |
| ---------- | --------------------------- | -------------------------------------------- |
| 2026-11-07 | [2026-11-07](2026-11-07.md) | [`2026-11-07.prs.json`](2026-11-07.prs.json) |

## Snapshot format

Each snapshot is two files named after the UTC date it was read:

- `<date>.md`: a short header, then the script's markdown output. The header
  gives the exact report time (`--now`), the `main` commit at that moment,
  the commands that produced it, and a few plain sentences on what the
  numbers do and do not show. The script's own headings are moved down one
  level so they sit under the snapshot's title; nothing else is changed.
- `<date>.prs.json`: the PR list the script read, as written by
  `--save-input`. It is the normalized list (number, title, body, state,
  timestamps, author, merger, labels), with the bodies of dependency-bot PRs
  left out because no metric reads them. Committing it means anyone can
  reproduce the snapshot offline, and check its classification by hand.

## Adding a snapshot

Snapshots are made by hand. The weekly workflow never commits: machines run
`main`, and a report has no reason to push there.

```bash
DATE=$(date -u +%F)
NOW=$(date -u +%FT%TZ)
GITHUB_TOKEN="$(gh auth token)" node scripts/pr-metrics.mjs --repo Danathar/appbox \
  --now "$NOW" --save-input "docs/metrics/$DATE.prs.json"
git rev-parse --short origin/main
```

Write `docs/metrics/$DATE.md` with the header described above and the
output beneath it, add a row to the table at the top of this file, and open a
pull request. To check a snapshot later, rerun it from its input:

```bash
node scripts/pr-metrics.mjs --input docs/metrics/<date>.prs.json --now <the same time>
```
