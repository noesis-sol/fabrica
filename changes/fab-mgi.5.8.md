- The console's History panel (`packages/ui/src/console/history.ts`): the scoped project's run's events from
  `run.watchEvents`, newest first and new ones on top, each a time, a 6×6 dot and one line cut with an
  ellipsis (whole on hover). The line is the event's own, as the log says it; its dot is `c1` for a start, a
  dispatch or a resumed session, `c4` for a merge, the run's end by itself or a full check that passed, `c2`
  for a question or a low battery, `c3` for a warning, a set-aside, a hold, a stop or a failed full check, and
  `c5` for organs, triage, answers, drains, lifted holds and other information. Records that only count or
  measure (turns, phases, the queue, checks, usage windows, ticket ends) have no row. The list is Foldkit's
  virtual list: only the rows in view are drawn.
- History's times are in the viewer's zone, from the clock's ticks (`packages/ui/src/app/clock.ts`), said as
  `sayMoment` says them: `14:03` today, `Wed 28 Oct 23:30` on another day (§7.7). The Model keeps the start of
  the viewer's day beside the time now, changed only as the day does, so History isn't redrawn every tick.
