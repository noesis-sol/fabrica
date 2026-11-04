- The machine budget: `machine_workers` (half the host's cores, at least 2, by default) caps the workers live
  across every run on the engine. A run short of a ticket it would take holds (`HOLD: MACHINE`) while it is
  reached, and goes on as one ends; a ticket past its work holds no slot, so it isn't counted, and the slots of a
  look are claimed atomically, so two runs can't take the last one. A machine hold stops the hand-backs' clock but
  not the workers' quiet, so one stuck is still noticed.
- Each worker's environment now carries its share of the cores (`FABRICA_CORES`, `GOFLAGS`), and it and every
  engine command (the merge check, the train's, the full check, setups, organ sessions) gets the cores divided
  among what is live as it starts, those commands counted.
- The host's load is sampled every 3 seconds and served on `engine.watchLoad`: each worker's process tree and the
  merge check's memory, memory pressure on macOS or pressure-stall information on Linux, swapping, the 1-minute
  load against the cores and the cores busy. Each sample is recorded in telemetry too.
