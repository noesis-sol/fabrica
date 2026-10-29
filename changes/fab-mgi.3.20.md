- `packages/contracts` has the worker's control group, `src/control.ts` (spec §12.2, §12.3, §20.2): one request
  per worker tool, shaped as `tools.ts` has them, the gate's `request_permission` and the extension's
  `report_unfinished`, every request carrying the session's token in a header (`ControlToken` middleware;
  `controlTokenClient(token)` for the client), and the variables the socket's path and token arrive in
  (`FABRICA_CONTROL_SOCKET`, `FABRICA_CONTROL_TOKEN`).
- `packages/engine` has the agent control server, `src/control/`: `ControlServer.open` gives an agent's session
  a Unix socket of its own (mode 0600, in a folder of mode 0700), serving the control group in the Schema RPC
  protocol, and a stream of the session's outcomes (`Finished`, `Deferred`, `WaitsFor`, `Asked`, `Unfinished`,
  `ToolFailed`). The token reaches the session's ticket and the tickets linked to it. `finish` is refused while
  the worktree has uncommitted or untracked files (named), for a commit or tree not HEAD's, without a
  `check_own` pass kept on the tree (`CheckOwnPasses`), or for a result not of the ticket's kind; it records the
  result on the ticket. `wait_for` links the ticket as blocked, refused while anything is uncommitted;
  `ask_and_wait` waits up to `question_wait` in time awake. Permission requests go to the `Attention` port.
  `Git.treeHash` reads a revision's tree.
