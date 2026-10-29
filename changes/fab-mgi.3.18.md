- The first-party Pi extension's gate (spec §12.6, §20.2) decides every call to a tool other than its own at
  the project's `permissions`, which the engine passes in `FABRICA_PERMISSIONS` (a new variable in
  `@fabrica/contracts`; `workspace` where none is given). `workspace` reads anywhere and writes and runs
  commands inside the worktree; it asks about writes outside it, network-reaching commands other than package
  managers, risky commands and what it can't read, and refuses `git push`, `sudo`, history rewrites of other
  branches and removals outside the worktree. `ask` asks about every write and command; `full` refuses only
  `git push`. Bash command lines are read through quotes, substitutions (inside `${…}` and `$((…))` too),
  here-documents, `cd` and wrappers (`env`, `timeout`, `xargs`, `bash -c`, `eval`, `find -exec`). A quote
  inside `${…}`, which shells read differently, makes the line unreadable; a line the gate can't read is
  asked about, but still refused where its words name `git push` (or `sudo`, below `full`). Path confinement
  checks every brace alternative of a glob, reads a glob segment that can match `..` as `..`, and refuses a
  brace that doesn't close or a pattern of more than 256 alternatives.
- A call the gate asks about goes to the engine whole (`request_permission`) and waits for the answer. A git
  command that writes the branch (commit, merge, rebase, reset, checkout…) first reads the ticket's place in
  the merge queue from the engine (`merge_standing`, new in the control group) and is refused, saying why,
  while the ticket waits to merge or merges (H59). Every decision is reported to the engine
  (`report_gate_decision`, new), which logs it; a gate that fails, or can't reach the engine, blocks the call.
- The engine's `ControlSession` takes the ticket's `mergeStanding`, which `merge_standing` answers.
