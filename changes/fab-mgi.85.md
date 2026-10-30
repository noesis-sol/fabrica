- The Windows app reaches an engine in WSL2 whose `fabrica` is only at `~/.local/bin/fabrica`, where Add engine
  links it, in a distribution whose PATH for a command run by `wsl.exe` lacks `~/.local/bin` (Ubuntu adds it in
  `~/.profile`, which such a command doesn't read): the bridge runs `fabrica bridge` where fabrica is on the PATH,
  and `~/.local/bin/fabrica bridge` otherwise, as the SSH bridge does. A distribution with neither is still said
  to have no fabrica, now naming `~/.local/bin` as well as the PATH.
