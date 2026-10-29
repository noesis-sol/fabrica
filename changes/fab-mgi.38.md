- `diff.ticket` asks the project's work graph first: a ticket it doesn't hold answers `TicketNotFound`, and
  `NoBranch` is kept for a ticket it holds with no `fabrica/<ticket>` branch. The Review group's handlers read
  their project through the Projects service.
