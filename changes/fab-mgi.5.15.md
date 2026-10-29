- The Backlog screen (spec §18.4, H24, H40): the scoped project's tickets from the backlog stream, in
  sections (open, epics with how many of their tickets are closed, ready, waiting with every reason in the
  engine's words from `tickets.why`, questions with the tickets they hold up, deferred with when they come
  back, the tickets the run finished, closed), each with a status mark in its role colour, a glyph and a word;
  a virtualised list; the chosen ticket shown whole (its description, why it isn't ready, a question's options
  or answer, its links); and the ticket graph, Cytoscape.js in a dagre layout styled from the theme's tokens,
  loaded as it is first drawn, a tapped node choosing its ticket. Read-only. What is ready and why is asked as
  each frame of the backlog comes, one request at a time.
- `tickets.edges` (spec §8.1): every link between a project's tickets in one request, as the Backlog graph
  draws them, read through the work graph's new `edges`.
