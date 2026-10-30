- Each worker runs under its supervision (spec §12.8, §14.5): a turn that ends on a provider's rate limit is
  resumed after an exponential backoff (30 s, doubling, six times, longer where the provider's retry-after
  asks), then set aside; one that ends on a usage limit or a refused credential waits on its hold and is
  resumed, nothing set aside; a worker with no events for 10 minutes, outside `check_own` and `ask_and_wait`
  and while the run doesn't hold, is interrupted and its session restarted once with a summary of where it
  went quiet, then set aside `AGENT_STUCK`; a tool's defect sets the ticket aside with a follow-up filed about
  the tool; a model that fails to start gives way to the next of `model_fallbacks`, and once none is left the
  failure is counted for the environment hold; a ticket's hand-backs start on the model that wrote it; a
  ticket past `ticket_limit` (its worker's time across its turns) or over its budget is interrupted and set
  aside, its worktree and session kept.
