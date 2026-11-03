- The project's requirements are checked on the engine's host (§17): at a run's start, before its first ticket and
  any worker carried over, and again once a merge changes the list on Base, before the next ticket starts. A failing
  check with an install has it run, its output in `.fabrica/run/requires-<name>.log`, and is checked again; what is
  still missing stops the run `REQUIREMENTS_MISSING`, exit 2, with one list, each entry with its instruction, once the
  running tickets finish where a merge changed the list. Only Base's list runs, read from the commit: a branch's
  entry, a dirty checkout's, or one a flag or variable gives is never run.
- `fabrica requires` says each requirement's state as the engine finds it, exiting 2 for one missing;
  `fabrica requires --markdown` prints the list for the README, between its markers.
