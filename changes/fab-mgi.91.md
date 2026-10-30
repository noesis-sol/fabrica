- The app's local engine no longer runs from the app's own folder, which an AppImage's or a dmg's unmount
  or an update takes from under it: the app installs a copy of the engine it bundles into
  `~/.local/share/fabrica/engine/<version>/`, as on a remote host, links `~/.local/bin/fabrica` to it, and
  starts the engine, or installs its login service, from there (spec §7.1).
