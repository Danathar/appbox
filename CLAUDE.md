# appbox

CI-built distrobox image (Signal, Claude Desktop) plus the host-side timer
that keeps each machine's `apps` box current. Read `README.md` for how it
works and `docs/working-on-the-repo.md` before changing anything. To set up
a new machine, follow `docs/install.md`; records of machines already set up
are in `hosts/*.md`.

Critical rules:

- `main` is live: every enrolled machine fast-forwards to it and runs it on
  its next timer run. Never force-push or rewrite `main`.
- Changed unit files (`host/*.service`, `host/*.timer`) need
  `systemctl --user daemon-reload` on each machine; self-update doesn't do it.
- Push an image change and wait for green CI before pushing an ini change
  that depends on it.
- Never bake Claude Desktop (or any proprietary app) into the image. It is
  public.
- Never run `host/appbox-update` against the real box without first checking
  yourself that Signal and Claude are not running. Test with the throwaway
  ini method in `docs/working-on-the-repo.md`.
- Ask before anything destructive on a host. Don't layer packages with
  rpm-ostree.
- Per-machine settings go in `hosts/<hostname>.env`, per-machine records in
  `hosts/<hostname>.md`.
- No em dashes in docs or commit messages.

Open follow-ups: `docs/TODO.md`.
