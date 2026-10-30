- Attention requests (spec §15.1, §15.2, §8.5), in `packages/engine/src/attention/`: the engine's open
  questions (from workers, organs, talks or the maintainer), the gate's permission requests (the tool call
  whole, and why it asks) and maintainer tasks, listed together for every project and watched as they change
  (`attention.list`, `attention.watch`, resumable). `attention.answer` takes the first answer: a later one is
  told which client answered and when, and the request's close in the stream says who answered. A client is
  named by the name its `engine.connect` hello gave.
- A question's answer is written into the design of each ticket it blocks, then recorded on the question,
  closing it as `answered`, as the maintainer's change: the blocked tickets become ready, a session waiting on
  it hears it, and the run wakes at once (H92). A question whose options would close, cancel, defer or freeze
  work is marked consequential as it is asked (H53). Any answer can be revised: the new answer replaces the
  old in the designs and on the question, tickets closed or deferred on the old one are reopened or
  undeferred, and what can't be undone (a merge, a ticket filed, a worker given the old answer) is listed.
- A permission request is answered allow once, allow for this run (the same tool with the same input is
  allowed for the rest of the run, without asking), or refuse with a note. Each run is given its own side of
  the attention requests by the engine; `fabrica serve`'s stand-in that answered as the project's
  `permissions` said is gone.
