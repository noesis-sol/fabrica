- A run's workers and verifiers start with the project's `permissions` in `FABRICA_PERMISSIONS`, so their gate
  enforces the level the project sets (`workspace` where none is set), not the default alone.
