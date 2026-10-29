- The Windows app's WSL2 host (`@fabrica/client/node`, the desktop's `main/wsl.ts`): it finds the WSL2
  distribution to run the engine in from `wsl.exe --list --verbose` (the default one, else the first,
  never Docker Desktop's or another tool's own), and where there is none installs Ubuntu with
  `wsl --install -d Ubuntu` in a console window of its own. It checks and installs the engine there with
  the install's own steps, run through `wsl.exe -d <distro> --exec`, installing the systemd user unit
  only where the distribution's systemd runs; elsewhere the bridge starts the engine.
- The connection process reaches an engine in WSL2 through `wsl.exe -d <distro> -- fabrica bridge`,
  telling a missing distribution or a missing `fabrica` apart from a lost link, which it tries again.
  As it connects, the app leaves a detached `wsl.exe` that holds the distribution running for as long as
  its engine answers, so closing the app leaves its runs running; it ends once the engine stops.
- A checkout under `/mnt/<drive>` in WSL2, its links resolved there, is warned about: git is slow there
  and POSIX semantics don't hold.
