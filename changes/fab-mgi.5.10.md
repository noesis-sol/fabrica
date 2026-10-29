- The console's Needs your attention column (`packages/ui/src/console/attention.ts`): each request as the
  handoff's card, its kind tag, its ticket and how long it has waited (`c2`). Approval (`c2`): a permission
  request's input shown whole and rendered for its tool (a command as its lines, an edit as its diff, a write
  as its path and content, any other call as its arguments), never cut off, and why it asks; Approve allows it
  once, its menu allows it for this run or refuses it with a note. Question (`c5`): the question's own title,
  the tickets waiting on it and its description as fits; Answer opens its options inline, the recommended one
  first and marked, and chosen unless the question is consequential, a free-text line and "Talk it through".
  Review (`c4`) for a set-aside ticket, with why, opening Review; Your task (`c2`) for a maintainer task, Done
  closing it. "Open session" opens the worker view. Every answer carries its request's ID.
- Keys 1–9 answer the question whose options are drawn, and only it: only 500 ms after they were drawn, a
  guard that starts again whenever that request changes, counted on the injected clock; options whose
  request leaves the list (answered elsewhere, or another scope chosen) close.
