- The Engines and projects screen (spec §18.4, §10.1, §20.3): the local engine with its connection's state, its
  release and protocol, and its status (host, start, projects, runs, workers against the machine budget,
  clients), asked as the screen opens; its projects, from the sidebar's rows; "+ Add project", adding a
  checkout on the engine's host by its path or a clone of a git URL through `projects.add`, the engine's
  refusal shown on the form, and "Set it up" (`projects.init`) for an added project without settings; and the
  engine's credentials, listed by name, set as a key (kept redacted in the Model and the Messages) or a
  command, and removed. The sidebar's "+ Add project" opens the screen with the flow open.
- The local engine (spec §7.1): at launch the app reaches the engine at its socket, as `fabrica bridge` does,
  and where none answers starts `fabrica serve` detached from the engine distribution it bundles
  (`<resources>/engine/bin/fabrica` in a packaged app; a development build starts none). "Run at login" on the
  Engines screen installs the login service through the bundled `fabrica service install`, through the
  preload's `installLoginService`.
