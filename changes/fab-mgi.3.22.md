- The engine daemon: `fabrica serve` runs the engine on a data folder per OS (`~/Library/Application Support/fabrica/`,
  `$XDG_DATA_HOME/fabrica/`) with `engine.db` (its identity, settings, projects and hashed tokens, migrated), a
  single-instance lock (a second engine exits saying one runs), and the protocol served as NDJSON on a local socket
  of mode 0600 in a folder only its user enters (under `$XDG_RUNTIME_DIR` on Linux where set). `fabrica bridge`
  connects stdin and stdout to that socket, starting the engine when none runs. The Engine group answers the
  handshake, `version`, `status`, `settings` and `stop`; every other group answers `NotImplemented` from its own
  handler file under `packages/engine/src/rpc/`. Stopping or SIGTERM ends the runs, then the agents, then the servers.
