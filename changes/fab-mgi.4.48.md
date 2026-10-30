- A talk's `file_tree` files its tree in one work-graph transaction, `WorkGraph.fileTickets`: its tickets,
  their parent edges and their `blocks` links together, so a running run's `ready` never sees a ticket of it
  before its waits, and a failure midway files nothing (§11.2, §15.4).
