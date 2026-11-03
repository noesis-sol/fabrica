- A run whose environment probe passed, or gave up, while the run was looking for work no longer ends
  `READY_EMPTY` there: the tickets the probe freed are taken again, and a failed probe ends it with exit 7.
  A look ends the run only on the holds it was woken for; a change it hasn't heard of has its wake on the way.
- Whole-run tests, every test file on the run harness, have 30 s rather than 15: on a loaded machine they ran past
  the limit without anything wrong.
- Tickets started together no longer fail at random as `TOOL_DEFECT`: a checkout's worktrees are added one at a
  time, as `git worktree add` side by side can die on another's half-written `commondir`. A worker that couldn't
  start for a git failure now says what git said, where it read `its worker couldn't start: ` with nothing after.
