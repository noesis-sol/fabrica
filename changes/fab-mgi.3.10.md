- The work graph's ready rule (spec §13.3) is built: `WorkGraph.ready` gives the tickets ready to
  dispatch, most urgent first, and `why` each reason a ticket waits, as a `WaitReason` that
  `describeWait` says in words (H81). A ticket is ready when open (or deferred past `defer_until`),
  not an epic, a question or a maintainer task, not set aside in this run, every `blocks` blocker
  closed and merged (`merged_commit` set, no branch, or its branch on Base as the caller's `onBase`
  says; otherwise `CLOSED_UNMERGED`), and the ticket it was filed from not running nor closed
  unmerged. Git is asked once of each closed blocker, only for tickets nothing else holds.
- `WorkGraph.closeEpics` closes each epic whose children are all closed and merged, nested epics in
  the same call; `close` returns the ticket with the tickets it blocks that aren't closed, which it
  offers to close with it (§11.1).
