- The answer talk (`fabrica talk answer`, the console's panel): given the open questions in scope with their
  options, the tickets they block, the ticket they were asked from and their notes, it shows each question's
  options, talks it through when asked, records the answer and goes on, new questions queueing into it. It
  drafts options for a question filed without them, marked so wherever they are shown. A maintainer's message
  that answers a consequential or maintainer-only question answers nothing else, so such a question is never
  answered in a batch. Deferred tickets are mentioned, and it has no tool to release them.
- A run with nothing ready but questions that block its tickets no longer ends: it says `QUESTIONS_WAITING`, its
  state is `asking`, and it takes up what each answer frees. A drain, its limit or a stop still ends it.
- `fabrica answer [<id>]` asks questions and permission requests on the terminal with their options; `t` or
  `--talk` opens the answer talk; `--option`, `--text`, `--allow`, `--refuse` and `--note` answer without asking,
  `--revise` changes an answer, and `--json` lists what waits.
