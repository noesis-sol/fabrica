- `packages/contracts` has the run's event stream (`events.ts`): every record kind, orchestra's with its
  field names and those added (`slept`, `battery`, `usage_window`, the credentials hold's, `turn`, `check`,
  `ticket_end`, `auto_answered`, `merge_conflict`), versioned, with times in local time and their UTC offset;
  a line of an unknown kind or version decodes as skipped. It has the hold kinds, the stop kinds and their
  exit codes, and (`phases.ts`) a ticket's phases with the one table of what each counts as, and the
  reasons a ticket is set aside.
