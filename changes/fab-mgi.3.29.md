- The run loop's core (`packages/engine/src/run/`, spec §13): a run's start checks (git 2.38 or later, the
  checkout clean and on a branch, the settings valid, each model's credential tried with the proxy's probe)
  list every problem together and end `SETUP`, exit 2, each check's end streamed as it comes and a defect in
  one its own problem line; the modes `--tickets` and `--ticket <id>`, `--limit` and `--concurrent`; free
  slots filled at once and on every change, each wake carrying its reasons; each dispatch claims its ticket,
  gives it a worktree from Base and a fresh Pi worker with its first prompt (its ID, earlier notes, the spec's
  sections it cites, its dependencies' results), its model and its proxy token; `finish` goes to the merge
  queue, `defer` sets the ticket aside, `wait_for` puts it back until the other ticket merges (its dispatch
  number reused), `ask_question` leaves it waiting; the end stops supervision first, closes every session at
  once, and writes the end line (`READY_EMPTY after N tickets`, `LIMIT_REACHED`, or the stop's kind, then the
  questions waiting), each ticket's `ticket_end` and the exit code. The run's state has one owner, changed by
  atomic transitions. The plug-ins M2 fills (footprints gate, setup, verifier, supervisor, holds, carry-over,
  end steps) are no-ops the loop calls.
