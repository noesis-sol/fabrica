- `packages/engine` has `PiAgent`, `src/agent/` (spec §12.1, H61, H74, H75): each worker is Pi's CLI in RPC mode
  (`--mode rpc --extension <first-party> --session-dir <data>/projects/<id>/sessions/<ticket>/ --no-skills`), run
  by the engine's Node through the process runner in the ticket's worktree, in a group of its own, with a
  configuration folder of its own (`PI_CODING_AGENT_DIR`) holding only the model proxy's provider entries and the
  agent's token, and no network of its own (`PI_OFFLINE`). Commands (`prompt`, `steer`, `abort`, `set_model`,
  `switch_session`, `fork`, `get_session_stats`) go as JSON lines on stdin matched to their answers by `id`, each
  answer waited on within a limit; records are split on LF only and decoded with Effect Schema, an unknown kind or
  one missing a field skipped and logged once. Acquire is spawn and handshake (`get_state`, after `switch_session`
  for a resume); release is abort, terminate (the whole tree) and reap, each within a limit; an interrupted prompt
  aborts its turn. A reaper beside each agent ends its tree when the engine dies without its finalizers. A ticket
  has one session at a time (Starting, Open, Closing): a start waits for a closing session's exit, a close during
  a start cancels it, an interrupted or failed start leaves nothing, and a command sent to a closing session fails.
