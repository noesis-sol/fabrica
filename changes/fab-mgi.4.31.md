- Tickets past their work (waiting to merge, merging, resolving, fixing) hold no slot up to `concurrent` of
  them, each beyond taking one, as orchestra counts them: with `concurrent: 2` and two tickets waiting to merge,
  workers still start in both slots, where none started until one merged. A hand-back's worker no longer takes
  a slot, and the console's live workers count the slots the scheduler counts.
