- The Worker, Backlog, Review, Insights and Engines screens are memoised on their own slices of the app's
  state, so the clock's tick or a run-view frame no longer redraws them whole (§18.5): the worker's
  transcript is redrawn only as its blocks, its list or its opened thinking change, the Backlog is given only
  the run's ticket rows, and the console's stats row only the run's header, totals, tickets, holds, banners
  and steps.
