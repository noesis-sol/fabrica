- The Worker view (`packages/ui/src/screens/worker.ts`), opened on its project from an In progress card, the
  palette or an attention card's "Open session": the ticket on top (its ID, type, priority, title and the start
  of its description; the whole ticket, with its design, acceptance, notes, links and the tickets it blocks, on
  a click or `t`); beside it the worker's time, its context against the model's window and its share of the
  usage window, marked an estimate; the transcript as it happens, drawn at most every 33 ms, with thinking
  collapsed, bare URLs as links, tool output in a read-only xterm.js terminal
  (`packages/ui/src/mounts/terminal.ts`) and an edit's or a write's change in Monaco, a tool call's input never
  drawn until it is whole; and a composer that messages the worker, interrupts it (`i`) and releases it (`r`),
  saying while it is steered, and once the worker has finished keeps its text and files it as a ticket. Only
  the worker shown has its transcript watched.
- A transcript has a `tool_input` entry: a tool call's input as the model streams it, which clients never draw.
- `@fabrica/ui` depends on `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0.
