- The stats row's Done today counts the day's tickets, not only the run's: the run view's totals carry
  `doneToday`, the project's tickets merged or closed with no change since the engine host's local
  midnight whichever run closed them, from the work graph's `doneSince` and the engine's `doneToday`.
