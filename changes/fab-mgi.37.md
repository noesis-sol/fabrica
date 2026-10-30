- A run keeps its host awake and watches its battery (spec §7.7, §15.6, H67): once its start checks pass
  and its `start` record is written, the run holds the idle-sleep inhibitor for as long as it goes, unless
  the engine's `keep_awake` is false and the run isn't overnight, an inhibitor that doesn't start said as
  `KEEP_AWAKE_FAILED:`; and it writes the battery's `LID_SLEEPS:` warning and `battery` records, at its
  start and at each threshold reached. The daemon's run hosting gives the runs the host's battery
  (`batteryFor` its platform) and the engine's process to keep awake.
