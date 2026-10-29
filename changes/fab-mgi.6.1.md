- The tickets ref's files, clocks and merge (spec §11.3, §11.4, §11.7) are built, pure, in
  `@fabrica/engine`'s `TicketsRef`: `tickets/<id>.json` (a ticket with its labels, the edges from it
  and its notes), `tombstones/<id>.json`, `meta.json` and `lease.json`, each encoded canonically
  (UTF-8, LF, two-space indent, a trailing newline, keys in code point order, every field present,
  ID lists sorted and each once, times ISO in UTC with milliseconds) and decoded by version, a newer
  record (`RecordTooNew`) or layout (`LayoutTooNew`) refused. Each changing field carries a hybrid
  logical clock, `<wall>:<counter>:<engine>`; `tick` issues one past every clock seen.
- `mergeSnapshots`, `mergeEntry` and `mergeTicketFile` merge the ref three ways against the base: one
  side's change; notes by ID; labels and edges as sets; plain fields by the later clock, ties by engine
  ID; status by precedence, a reopen after a close winning by its clock, a close's resolution and
  reason with its status; a claim or release made under an expired lease losing to the holder's; an edit
  over a deletion. Each field both sides changed, and each deletion lost, comes back as a
  `MergeConflict`. `mergeLease` keeps the earlier start of two leases covering the same time.
- fast-check 4.10.2 joins the engine's dev dependencies for the property tests (spec §24).
