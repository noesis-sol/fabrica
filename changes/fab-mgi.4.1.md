- `packages/engine` has footprints, `src/footprints/` (spec §13.4, H70): pure rules over the files git tracks at
  Base. A ticket's footprint is its `files` (tracked files, folders, globs, and names it adds), its `area:`
  labels and, while it runs, the files its worktree changed (`withChanges`); only a ticket with no `files` has
  its title, description, design and acceptance read, for tracked paths, tracked bare names where capitalised
  or quoted, and functions, the documents it only cites kept apart from those it changes; with nothing named,
  its `predicted_files`. A ticket past its work holds on its branch's files (`branchFootprint`). A function
  counts only where a tracked source file declares it (`readDeclared`), `Type.method` only when both parts are
  declared, and a file mentions it only in its code, comments and strings left out by its language's syntax; a
  folder's or a glob's tracked files are looked in too.
  `overlap` gives `Holds` (an area, a function, or a path one side is to change), `LikelyConflict` (only files
  merged by union, the check commands' files and what they run through scripts, the
  manifest's scripts and the Makefile, `checkFiles`, or `shared_files`), or `Clear`.
  Globs collapse runs of `**` and remember the ways that failed; contents are read, through a `ReadSource`,
  only for pairs where one names a function (`readMentions`).
