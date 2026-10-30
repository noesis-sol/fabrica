- `projects.remove` (and `fabrica project remove`) is refused with `RunGoing` while the project has a run going,
  rather than closing the run's work graph and deleting a clone's checkout and worktrees under it; no run
  starts on a project being removed, and a refresh under way no longer opens a removed project's work graph
  again or sends its row back.
