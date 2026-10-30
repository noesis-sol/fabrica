- The app and `fabrica --engine ssh://…` reach an engine whose `fabrica` is only at `~/.local/bin/fabrica`, where
  the install links it, on a host whose PATH for a non-interactive ssh command lacks `~/.local/bin` (Ubuntu adds
  it in `~/.profile`, which such a command doesn't read): ssh runs `fabrica bridge` where fabrica is on the PATH,
  and `~/.local/bin/fabrica bridge` otherwise, in a form every login shell runs (sh, bash, zsh, fish, csh). A
  host with neither is still said to have no fabrica, now naming `~/.local/bin` as well as the PATH.
