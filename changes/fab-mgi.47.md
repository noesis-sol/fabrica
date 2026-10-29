- The engine's restart into an update under the login service (spec §7.1, §9.2): the launchd agent and the
  systemd user unit set `FABRICA_SERVICE` to their manager's name, which `fabrica serve` reads once as it
  starts. Run by the service, an updated engine starts no `fabrica serve` of its own (systemd's
  `KillMode=mixed` would kill it as the old engine exits, and launchd's `KeepAlive` would start a second one
  beside it): once its scope has ended it exits with code 75, which both managers restart it on, and the
  manager starts the new release from the `fabrica` link the update switched. Outside the service it starts
  the new launcher's `fabrica serve`, detached, as before. A service installed before this change needs
  `fabrica service install` again.
