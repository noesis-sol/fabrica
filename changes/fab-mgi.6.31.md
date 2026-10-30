- The worker's transcript draws only the blocks in view, each measured as it is drawn: a tool call's terminal
  and an edit's diff view are made as their block comes into view and disposed of as it leaves, so a session
  of hundreds of tool calls no longer holds hundreds of terminals and editors. It follows its end while it is
  scrolled there, and stays on the block read otherwise (spec §18.5).
- Insights' tables and Review's changed files draw only the rows in view: a table's rows scroll under its
  column headers, at most 12 in view (spec §18.5).
