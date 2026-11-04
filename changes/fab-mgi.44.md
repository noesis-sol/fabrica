- The gate's path confinement (spec §12.6, §20.2, H62) reads a path on the file system, a segment at a time, rather
  than as written (`gate/paths.ts`): a link is followed, a dangling one too, `..` after a link is its target's
  parent, and the worktree is compared by its real path. A write through a link out of the worktree is asked and a
  removal through one refused; removing the link itself (`rm link`) stays allowed, as `rm link/` and `shred link`
  don't. `cd` and Pi's file tools take `..` off a path first, so that reading must stay inside as well.
- A wildcard segment now stands for every entry of its folder, so `rm -rf */x` is read through a link among them;
  past 4096 steps the gate asks. A `cd` to a wildcard follows each entry, so more than 64 of them ask.
- `ln -s` to a target outside the worktree asks: the link isn't on disk yet for the rest of its command line to be
  read through.
