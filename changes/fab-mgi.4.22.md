- The install script always links `~/.local/bin/fabrica` to the engine it installs, the link `fabrica engine
  update` switches and the login service runs; `FABRICA_INSTALL_DIR` only adds `<folder>/fabrica`, a link to
  `~/.local/bin/fabrica`, so that an update reaches the `fabrica` the user runs.
