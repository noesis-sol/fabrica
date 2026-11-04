- `fabrica run --auto-answer[=<duration>]`, or the engine's `auto_answer`, now answers a run's questions while the
  maintainer is away: at once, or after the wait in time awake, so one who is there answers first. It takes a question
  filed during the run with options, neither consequential nor `maintainer_only`, and answers with its recommended
  option in words that say `--auto-answer` chose it, not the maintainer. The question is labelled `auto-answered`, the
  resumed worker told, and an `auto_answered` event says so in History; the `start` record carries the wait, which is
  what keeps the app from notifying about a question answered at once. A question it will answer keeps the run from
  ending, unless the run drains. Revising such an answer takes the label off: the answer is the maintainer's then.
- A worker that asks a question whose answer has already come now goes back to its ticket in the same run, rather than
  the run ending with the ticket still waiting.
- An answer the work graph refuses no longer stops the engine: the client is told it was already answered.
