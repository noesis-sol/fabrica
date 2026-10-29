- The Insights screen (spec §18.4, §21): the scope's telemetry over all its time, a summary (runs, merged,
  set aside, hand-backs, tokens, cost, the median from ready to merged) and a panel per named query of the
  Insights group: tokens and cost per model by run, ticket or project; cost per merged ticket; time per
  phase (a project's only); check durations and failures; flaky tests; the maintainer's waits; hand-back and
  set-aside rates; models compared on similar tickets. Each is asked as the screen opens, its scope changes
  or Refresh is pressed, and drawn from the engine's table, each cell in its column's unit; an answer for a
  query no longer shown is dropped, and a failed refresh keeps the last answer with why beside it.
