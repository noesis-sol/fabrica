- The Backlog RPC group is served on each project's work graph (spec §8.1, §11.1), every change the
  maintainer's: `tickets.list` (by status, type, every label named, or parent), `show`, `create` (a question
  is refused: workers and talks ask them), `update` (its `status` reopens, defers or undefers), `close`,
  `dep.add`, `dep.remove`, `label`, `note`, `ready` and `why`, whose answer now gives each reason with the
  words the log says it in. What the work graph refuses (a cycle, a transition its status doesn't allow) is
  `Refused`, in its words. The backlog stream sends the project's tickets, then a numbered patch per change,
  which a client resumes after its last, as the project status stream does: both are one keyed feed now.
  `tickets.import` is the Beads import's.
- `fabrica tickets list|show|create|update|close|reopen|defer|dep add|dep remove|label|note|ready|why`
  (spec §19) talk to the engine, with `--json`, on `--project <id>` or the project whose checkout holds the
  folder they run in; `create --files` and `update --files` give a ticket's footprint (§13.4), and `why`
  prints each reason in words. `fabrica tickets rebuild` says it waits for the tickets ref (M4).
