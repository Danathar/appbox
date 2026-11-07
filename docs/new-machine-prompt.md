# Prompt: install appbox on a new machine

Paste everything below the line into Claude Code on the machine being set up.
It works on any machine; the session works out what kind of machine it is.

---

Put this machine on appbox, my CI-built distrobox image for desktop apps, and
move its GUI apps out of whatever distroboxes they live in now.

1. Clone the repo first, then read its instructions before doing anything
   else:
   ```sh
   git clone https://github.com/Danathar/appbox ~/claude/appbox
   ```
   Read, fully: `CLAUDE.md`, `README.md`, `docs/install.md`,
   `docs/working-on-the-repo.md`, and every `hosts/*.md` (records of machines
   already set up, with lessons learned).
2. Follow `docs/install.md` step by step, including its ground rules. Stop
   and report after the inventory (step 1), and wait for my answer on the app
   plan (step 2) before changing anything.
3. Work out for yourself whether this machine is a laptop that sleeps or an
   always-on machine, which GPU it has, and how it gets OS updates, and apply
   the matching parts of the guide.
4. Anything you push to `main` reaches every enrolled machine on its next
   timer run. Follow `docs/working-on-the-repo.md` for every repo change.
5. Finish by recording this machine in `hosts/` and giving me the report
   described at the end of `docs/install.md`.
