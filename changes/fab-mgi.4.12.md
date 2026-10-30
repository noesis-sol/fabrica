- The usage-limit hold (spec §14.2, H20, H60): a model call of the run refused for a quota with a reset, a
  worker's or an organ's as the model proxy sees it, holds the whole run for its provider (`HOLD: USAGE_LIMIT`
  and a `usage_limit` record, its reset said with its day when it isn't today); the proxy's permits hold back
  that provider's calls of the run until the hold lifts, and running workers wait with their hand-back clocks
  stopped, carrying on once it lifts. At the reset the proxy makes one probe call and the hold lifts when it
  goes through (`usage_limit_lifted`); a reset at or before now is taken as unknown, probed every
  `usage_limit_retry`, and any call to the provider that goes through lifts it too; two lifts are at least
  `usage_limit_retry` apart. A worker's turn ended on a refusal whose hold has lifted since carries on at once.
  Past `usage_limit_wait` the run ends `USAGE_LIMIT`, exit 8, its workers kept for the carry-over.
