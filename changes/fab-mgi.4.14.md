- Cost accounting (`packages/engine/src/cost`): each model call the proxy counts is priced at pi-ai's tables
  (`@earendil-works/pi-ai` 1.4.0, now an engine dependency: each built-in model's price per million tokens,
  with its input-size tiers), a call on an API key in money and a subscription's call at its API-price
  equivalent, marked as such; a model the tables lack is left unpriced. A run's `CostAccount` records each
  call as a `model_calls` row tied to the project, the run and the call's ticket, and adds it up per ticket,
  per session (a `turn`'s share since the last) and for the run (its workers' calls apart from those tied to
  no ticket), giving the `tokens`, `cost_usd` and `equivalent_usd` fields of `turn`, `closed` and `end`.
- The event stream's `turn`, `end` and the records of what a ticket spent (`closed`, `deferred`,
  `ticket_end`, a set-aside `warn`) have `equivalent_usd` beside `cost_usd`, which stays money; telemetry's
  `model_calls` and `daily` have an `equivalent_usd` column (migration `0002_model_call_equivalents`),
  rolled up with the rest.
- The model proxy's `Used` event carries the call's latency, from its request sent to its response's end,
  and its time to the first byte, both on the engine's clock.
