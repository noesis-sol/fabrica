- The Windows app adds an engine in WSL2: Add engine offers "In WSL2" beside SSH on Windows, shows the
  distribution the app found (`fabrica:find-wsl`), offers to install Ubuntu where there is none
  (`fabrica:install-ubuntu`, WSL asking for its user in a window of its own) or says why WSL can't run, and
  checks and installs the engine there as on any host (`EngineHost.Wsl`, through `wsl.exe -d <distro>
  --exec`), its login service only where the distribution's systemd runs.
- The Windows app reaches its engine in WSL2: once Add engine has installed it there, and at launch the
  first known engine in WSL2, where this machine runs none. Every page gets a new port to it, the
  distribution is held running while its engine answers, and a connection stopped at the bridge's refusal
  is tried again after the install.
- Adding a project whose folder is on a Windows drive (`/mnt/<letter>`) warns that git is slow there and
  POSIX semantics don't hold, as the path is typed and once the project is added.
