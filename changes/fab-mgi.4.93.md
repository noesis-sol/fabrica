- The gate asks about a line it may read otherwise than bash, and still reads what it can, so a refusal stays one: a
  line continued right after a `$`, a backtick substitution, a here-document left open in a substitution, and a
  comment in a substitution holding a quote or parenthesis. Each of these could hide a `git push` from it.
- It also asks about a continued line in a here-document or its delimiter, a line break in a substitution while an outer
  here-document waits for its body, a `)` of its own in a here-document in a substitution, a `$((` that closes early, and a
  `<<` in `$[…]` or a subscript. A `for` or `select` with no `in` has its body read, so a push there is refused.
