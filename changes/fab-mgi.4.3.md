- The verifier after `finish` (`packages/engine/src/run/verify.ts`, spec §13.6): a separate, read-only Pi
  session in the ticket's worktree (Pi's `--tools read,grep,find,ls,bash,verdict`, the verifier's own
  standing rules, `FABRICA_AGENT_ROLE=verifier`), given the ticket and the diff but none of the worker's
  reasoning, on `verifier.model`, else a configured model of another provider than the worker's, else the
  worker's. It is told the worker's `check_own` pass on the finished tree stands, and its environment names
  the last pass's tree (`FABRICA_CHECK_OWN_PASSED_AT`). It answers through `verdict`, a new control RPC that
  only a verifier's session may call (a verifier's call of a worker's tool is refused, as is a finding
  disagreeing with a round not before its own). A PASS goes to the merge queue; a FAIL is noted on the
  ticket and handed back to the worker, its session resumed, with the round's and the earlier rounds'
  findings, at most `verifier.rounds` times, a finish after the last going to the merge queue unverified; a
  round that disagrees with an earlier one (`DISAGREES WITH ROUND <n>`) is handed back for the worker to ask
  the maintainer; a verifier with no verdict sets the ticket aside. `verifier.enabled: false` sends a finish
  straight to the merge queue.
