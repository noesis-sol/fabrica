- A run keeps a cost account from its start, before any session is granted a model-proxy token: every call
  the proxy counts to the run is priced and recorded in telemetry as the run goes (every provider is billed
  as an API key until the proxy tells subscriptions apart). The daemon's runs record into its Telemetry.
- The run writes a `turn` record for each turn of a worker's and a verifier's agent, from its start to its
  settle (or its session's close): its model round-trips, how long it took, the model its last answer
  named, and its share of the session's `tokens`, `cost_usd` and `equivalent_usd`.
- `closed`, `deferred` and `ticket_end` carry what their ticket spent in the run so far, and `end` what the
  run's workers spent.
