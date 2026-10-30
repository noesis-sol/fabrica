- The holds are one state (spec §14, H58): each hold keyed by its kind and, for a usage limit or a refused
  credential, its provider, raised and lifted through atomic transitions that write their `hold` records, so
  lifting one never lifts another. Whether the run may take work is read from one snapshot of the holds and the
  drain each look; the banners, the hand-backs' and workers' clock (stopped while the usage limit or the
  machine holds) and the run's stopping are derived from it, and a run with a hold that can lift waits rather
  than ending. A worker's usage limit and refused credential now hold the run for their provider until a timed
  lift (the proxy's probe comes with their own tickets).
- The environment hold (§14.1): three tickets in a row settling within five minutes with no outcome and no
  change, sessions that don't start among them, or three setups failing one after another hold the run
  (`HOLD: ENVIRONMENT`), put those tickets back to wait for the probe (`reopened`), and after `env_probe`
  (10 min) probe the machine with a minimal agent: `PROBE_OK` lifts the environment hold alone and frees the
  tickets waiting for it and those whose setup failed; a failed probe ends the run `ENVIRONMENT`, exit 7. A
  wait for a ticket not merged and a refused credential aren't counted.
