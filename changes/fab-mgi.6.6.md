- The app installs and updates engines on other hosts (`@fabrica/client/install`): over SSH, in WSL2
  through wsl.exe, or on this machine, all through one host shell. It checks the host first: its system
  and CPU against the engine's floors (macOS 13.5, glibc 2.28 with libatomic.so.1, SSE2 on x64), the
  tools the install needs, and the engine already in `~/.local/bin/fabrica` and its version. It verifies
  the release's signed checksums.txt before trusting a sum in it, refuses a distribution with no engine
  for the host's architecture, and proposes installing, updating an older engine, nothing, or the app's
  own update where the host's engine is the later. With the user's consent, and the host checked again,
  the host downloads the archive (or the app sends it), checks its SHA-256, unpacks it into
  `~/.local/share/fabrica/engine/<version>/`, runs its `--version`, relinks `~/.local/bin/fabrica`, and
  runs `fabrica service install`, which starts the engine. On an update the old engine winds its runs
  down and stops first.
