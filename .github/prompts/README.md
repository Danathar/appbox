# Prompt catalog

Reusable prompts for appbox tasks that come up more than once. The files use
the `.prompt.md` format of Copilot Chat and VS Code (a `description` in the
frontmatter, `${input:...}` placeholders), and the text works as a plain
prompt in any other tool. Every prompt assumes the rules in
[AGENTS.md](../../AGENTS.md), above all: `main` is live on every enrolled
machine, never bake a proprietary app into the image, never run
`host/appbox-update` (other than `--show-config`) on a real machine, and pass
`-R Danathar/appbox` to every `gh` command.

| Prompt                                                               | Use it when                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [ubuntu-release-upgrade.prompt.md](ubuntu-release-upgrade.prompt.md) | ublue moves `ubuntu-toolbox:latest` to a new Ubuntu release and the build fails on purpose |
| [triage-failed-build.prompt.md](triage-failed-build.prompt.md)       | A `build-appbox` run (nightly, push or manual) failed                                      |
| [review-pr.prompt.md](review-pr.prompt.md)                           | Reviewing a pull request against appbox's rules and its machine impact                     |

Add a prompt as `<verb-noun>.prompt.md` with a `description` in its
frontmatter, and add a row to the table above.
