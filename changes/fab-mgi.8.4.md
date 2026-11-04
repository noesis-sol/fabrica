- Budgets (spec §14.4, H21): `budgets.project`, `budgets.run` and `budgets.ticket`, each in tokens or money, are
  measured against the run's cost account as each model call's response ends (`holds/budget.ts`). A ticket at its
  budget is interrupted and set aside `BUDGET_EXCEEDED`, the run going on. A run or project at its budget
  dispatches no more (`HOLD: BUDGET`), its running workers finishing and merging; the hold never lifts, so the run
  ends `LIMIT_REACHED` (exit 0) once they have, rather than waiting. A budget in money counts money alone, not a
  subscription's API-price equivalent; a budget in tokens counts all of them, the cache's included. A ticket's and
  a run's budgets are this run's; a project's adds what telemetry has recorded of it, raw rows and daily rollups,
  through the new `Telemetry.projectSpent`, read once as the run starts. With no budget set, nothing is read.
- `tokenTotal` moves from the console's stats to `@fabrica/contracts`, so that the console and a budget count
  tokens by one rule; the cost account gives its figures as they change (`changes`).
