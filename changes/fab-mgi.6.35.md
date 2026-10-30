- Review shows a set-aside ticket's notes beside its branch diff: its title and each note with who wrote it
  and when, where the worker, the verifier or triage said why it was set aside (spec §18.3).
- The Report view lists the project's runs, newest first, with when each started, and reads the report of
  the one chosen; the choice holds while the screen shows that project (spec §18.4).
- `report.list`, a new Review request, gives a project's runs as its event stream started them, newest
  first, leaving out a run whose report couldn't be read (spec §8.1).
- Review's changed-files list is 260px wide again: its width class drew nothing under the theme's spacing.
