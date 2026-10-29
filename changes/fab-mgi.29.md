- A ticket's `check_own` passes are kept in the project's work graph (`.fabrica/work.db`, migration 2), not in
  the engine's memory: a carried-over ticket's worker can `finish` on a pass it made before the engine
  restarted, and its next `check_own` gets `FABRICA_CHECK_OWN_PASSED_AT`. The passes go as the ticket closes
  (its merge closes it) or is deleted.
