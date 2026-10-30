- The credentials hold (spec §14.6, H69): a model call refused for its credential once a call to its provider
  has gone through in the run, a worker's or an organ's as the model proxy sees it, holds the run for that
  provider alone (`HOLD: CREDENTIALS`, naming the provider, the credential's account and the reason, and a
  `credentials_hold` record). The proxy's permits hold back that provider's calls of the run while its other
  providers go on; its running workers wait with their hand-back clocks stopped, and no ticket is deferred,
  set aside, triaged or counted toward the environment hold for it. The proxy probes the provider every
  minute, and once a probe goes through after a new sign-in or key the hold lifts (`credentials_lifted`) and
  the waiting workers are told to carry on. Past `credentials_wait` (6h) the run ends `CREDENTIALS`, exit 2,
  its workers kept for the carry-over. A refused credential's account now comes with the proxy's refusal.
