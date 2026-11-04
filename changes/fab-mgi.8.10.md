- A soak test holds one engine flat through 52 runs (H77): `packages/engine/test/soak.test.ts`. What it and the audit
  behind it found goes with its scope: a done ticket's transcript as the ticket is done, not as its run ends; a run's
  calls that went through, which the model proxy kept as long as the engine lived, as the run ends; and the answers
  kept to tell a late answer who came first, which grew for as long as the engine lived, are held to the latest 1024.
- A read of a file interrupted as it opens closes what it opened, as a write does: a run's settings read, interrupted
  as the run stopped, left its handle to the garbage collector, an uncaught error on the pinned Node.
