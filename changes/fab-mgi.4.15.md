- The engine serves each run's view (`run.watchView`, spec §8.3): its header, totals (Done today included,
  read again on ticket changes and at the host's midnight), ticket rows with their phase, since when and
  their hand-backs, workers with their latest action from Pi's events, the merge queue, banners, and every
  engine step under way with its start time (the start's checks, the backlog, the carry-over, a setup, the
  merge check). A fiber of its own writes it at most every `view_interval`, publishing only a view whose
  parts changed, every unchanged part and row keeping its identity; it streams as a snapshot then numbered
  patches, resumable after a sequence number.
- The Workers group is served: `worker.message` steers a worker (into its running turn, or as its next
  turn; the engine sends it nothing more until `worker.release`), held while its ticket waits to merge or
  merges (H59); `worker.interrupt` aborts its turn; `worker.watchTranscript` streams its transcript, batched
  every `stream_flush`, only to a client that asks for it.
