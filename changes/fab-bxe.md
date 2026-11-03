- A ticket's `closed`, `deferred` and `ticket_end` records carry `hand_backs` (`resolve`, `fix`), its hand-backs in
  the run as the merge queue counted them, left out where it had none; each hand-back is recorded in telemetry
  as a hand-back row, so Insights' hand-back rates and a ticket's time see them.
