- The backlog now lives on a git ref of its own as well, `refs/fabrica/tickets`: the engine commits its
  changes there with git's plumbing, batched for at most 2 s and at once on a claim, a close, a merge or a
  question, and never touches a checkout, an index or a hook. Fetching and pushing the ref to a remote are in
  place (its schedule follows); two engines' backlogs merge field by field, a deletion losing to an edit.
- A result over 64 KB stays local, and a secret pattern in what is to be exported blocks the commit and warns.
- `fabrica tickets rebuild` rebuilds a project's work graph from the ref. It used to say it wasn't there yet.
- `fabrica tickets why` says when a sync made a cycle of `blocks` links through a ticket.
