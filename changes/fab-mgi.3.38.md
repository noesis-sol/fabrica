- `fabrica engine update [<version>]` and the engine group's `engine.update` (spec §9.2, §20.4): the engine
  downloads the latest release's `checksums.txt` and `checksums.txt.sig` (or the named release's), verifies
  the signature with its release keys (`packages/engine/src/update/keys.ts`, which must agree with
  `scripts/install.sh`'s) before trusting any sum, takes its version from the signed sums, downloads its
  archive for this host and checks its SHA-256, unpacks it in a folder of its own under
  `~/.local/share/fabrica/engine/`, runs the new `fabrica --version` there (stdout only), renames it into
  `~/.local/share/fabrica/engine/<version>/` and relinks `~/.local/bin/fabrica` by a rename, then answers and
  restarts: its runs wind down as on a stop, and once its lock is released it starts the new release's
  `fabrica serve`, detached. It refuses the release it runs, a latest older than it, a second update while
  one is under way, and any update once it is stopping; with no release key yet, it installs nothing.
- The installer's steps live in `packages/engine/src/update/` (`Update` in `@fabrica/engine`), for the app's
  install over SSH to reuse.
