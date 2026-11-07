# Prompt: install appbox on a new machine

Start the session from the checkout, with the owner switch, then paste
everything below the line into it. On the machine being set up:

```sh
git clone https://github.com/Danathar/appbox ~/claude/appbox   # skip if already cloned
cd ~/claude/appbox && git switch main && git pull --ff-only
APPBOX_OWNER_SESSION=1 claude
```

The switch lets this session run the setup commands (creating the box,
`host/install`, the first update run) that the repo's guard hook refuses to
every other agent; see "The Bash guard" in `AGENTS.md`. It works on any
machine; the session works out what kind of machine it is.

---

Put this machine on appbox, my CI-built distrobox image for desktop apps, and
move its GUI apps out of whatever distroboxes they live in now.

1. Check how you were started before anything else: you should be running
   in `~/claude/appbox` (or another appbox checkout) on `main`, and
   `echo "${APPBOX_OWNER_SESSION:-}"` should print `1`. If either is not
   true, stop and ask me to restart Claude Code as described at the top of
   `docs/new-machine-prompt.md`. Without the switch the guard hook refuses
   the setup steps partway through.
2. Read, fully: `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/install.md`,
   `docs/working-on-the-repo.md`, and every `hosts/*.md` (records of machines
   already set up, with lessons learned).
3. Follow `docs/install.md` step by step, including its ground rules. Stop
   and report after the inventory (step 1), and wait for my answer on the app
   plan (step 2) before changing anything.
4. Work out for yourself whether this machine is a laptop that sleeps or an
   always-on machine, which GPU it has, and how it gets OS updates, and apply
   the matching parts of the guide.
5. `main` only takes pull requests: never push to it. Every repo change goes
   on a branch with a pull request that merges once the required checks pass
   (`docs/install.md` step 8 has the exact commands). A merge reaches every
   enrolled machine on its next timer run. Follow
   `docs/working-on-the-repo.md` for every repo change.
6. Finish by recording this machine in `hosts/` through a pull request,
   merging it, switching the checkout back to `main`, and giving me the
   report described at the end of `docs/install.md`.
