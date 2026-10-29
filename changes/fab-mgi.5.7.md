- The console's stats row (`packages/ui/src/console/stats.ts`), for the scoped project's run: workers live
  against the slots ("4 of 4", `c1`), done today (`c4`), set aside (`c3`), needs you (`c2`), in queue (`c5`)
  with how many wait and, on hover, each waiting ticket with why in words, and tokens (`c5`, "1.2M"). At its
  right end the run's controls: Start run and its modes (the current tickets, one ticket, a spec, refined first
  or not, a feature, overnight) while the project is idle, Drain (Undrain while draining) and Stop, confirmed
  first, while its run goes, and an overnight run's `c5` tag. A strip above the row holds the run's holds and
  banners, `c2` for a hold and `c3` for a stop with the word beside the colour, and when each lifts (a time,
  with its day when it isn't today), the engine's run-wide steps past a second with their elapsed time, and a
  request the engine refused, in words.
- Why a waiting ticket waits, in words, is one module (`packages/ui/src/console/waiting.ts`), for the stats
  row and Up next alike.
- The renderer has a clock (`packages/ui/src/app/clock.ts`): the time now in the viewer's zone, ticked about
  every second while connected and kept in the Model, and how the console says a moment and a time gone by.
  A run started from the app has its run view watched afresh.
