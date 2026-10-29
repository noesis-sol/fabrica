- The console's sidebar lists projects and their runs: "Projects" with the count, an "All projects" row, then one
  row per project on every known engine with its chip (the five role colours in turn, its two-digit index), its
  name, its Base (with the engine's name where more than one engine is known) and its run's state, Running,
  Waiting or Idle, with an `overnight` tag for an overnight run. The rows come from the engine's
  `projects.watchStatus` stream. Selecting a row scopes the main area to its project (selecting the scope
  already chosen changes nothing), and "+ Add project", pinned at the bottom, opens the Engines screen.
