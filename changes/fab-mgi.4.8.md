- The merge queue has its merge train, `src/merge/train.ts` (spec §13.7, orchestra-8qk2): while one ticket's
  merge check runs, the ticket waiting first in line rides beside it, rebased onto the first's rebased head in
  its own worktree, set up where that rebase brought in a setup file, and checked there (its `check` record
  marked `train`). When the first merges as checked, the second merges on that check with no further one;
  otherwise its branch is put back where its worker left it (`Git.resetTo`), set up again where the ride set
  it up, and its turn prepares it afresh. A stop puts a ride's branch back too. One ticket rides at most
  (`merge.train`, 0 or 1, now in `MergeConfig`), and none while the `MachineHold` port says the machine budget
  holds (it never holds until the machine budget fills it).
