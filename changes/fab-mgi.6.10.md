- `fabrica service install|uninstall|status` (spec §7.1, §19): the login service that runs `fabrica serve` from
  the `~/.local/bin/fabrica` link, with the installing shell's PATH and XDG folders. On macOS it is the launchd
  agent `fabrica.engine` (`~/Library/LaunchAgents/fabrica.engine.plist`, bootstrapped in `gui/<uid>`, its
  output in `<data>/logs/service.log`); on Linux the systemd user unit `fabrica.service`
  (`~/.config/systemd/user/`), with `KillMode=mixed` (fab-mgi.17): SIGTERM reaches the engine alone, which
  winds its runs down, and what is left in its cgroup is killed after it exits. Both wait 120 s for the
  wind-down and restart the engine only where it fails. Installing on Linux enables the user's linger, and
  where logind refuses says so with `sudo loginctl enable-linger <user>`. `status` says whether the service
  is installed and whether its engine runs, with its pid. The service's files and commands live in
  `packages/engine/src/service/` (`LoginService` in `@fabrica/engine`).
