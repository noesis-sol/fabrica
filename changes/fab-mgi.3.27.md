- `fabrica tickets import --beads <file>` and the Backlog group's `tickets.import` bring a Beads backlog (a
  `bd export` JSONL file) into a project's work graph (spec §11.6), IDs kept with their prefix: types (one
  Fabrica lacks becomes a task labelled with it), statuses (`blocked` and `pinned` open, `hooked` in progress,
  an open ticket with a defer time deferred), priorities, labels, `blocks`, `parent-child`, `discovered-from`
  and `related` links, comments and notes as notes, design, acceptance criteria and metadata. A ticket
  labelled `human` with options in its metadata becomes a question, answered as `bd human respond` answered
  it, cancelled when dismissed. A file with a record the work graph can't hold is refused whole, with every
  problem by line; a link of another kind, or to a ticket neither the file nor the project has, is left out
  and said. Importing into a project with tickets merges them until the tickets ref's merge exists: the
  file's fields, the later status by §11.4's precedence, labels, notes and links as unions, a deleted ticket
  left deleted; each ticket changed is reported with its fields, and importing the same file again changes
  nothing. A long import writes in batches that yield, in one transaction.
