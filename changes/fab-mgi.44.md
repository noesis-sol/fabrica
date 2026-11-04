- The gate's path confinement (spec §12.6, §20.2, H62) reads a path on the file system, a segment at a time, rather
  than as written (`gate/paths.ts`): a link is followed, a dangling one too, `..` after a link is its target's
  parent, and the worktree is compared by its real path. A write through a link out of the worktree is asked and a
  removal through one refused; removing the link itself (`rm link`) stays allowed, as `rm link/` and `shred link`
  don't. `cd` and Pi's file tools take `..` off a path first, so that reading must stay inside as well.
- A wildcard segment now stands for the entries of its folder it may match, at any depth where it is `**`, so
  `rm -rf */x` is read through a link among them; a bracket stands for them all, and past 4096
  steps the gate asks. A `cd` to a wildcard follows each entry, so more than 64 of them ask.
- `find`'s options before its roots are read (`find -H out -delete` and BSD's `find -Hf out -- -delete` remove
  through `out`), `+` ends its `-exec` only straight after `{}`, and `find -L` that acts
  on what it walks, and `chmod`, `chown`, `chgrp` and `chflags -L`, ask: they follow links the gate doesn't walk.
- A Pi file tool's path is also read as the plain text Pi opens, its Unicode spaces plain, so a link named `{a,b}` or
  `q\z` is followed; its reading as a shell pattern stays, so that one the gate refuses stays refused.
- `{}` under `find -exec`, alone or in a longer word, stands for anything below the root, so `chmod`, `tee` or
  `shred` of a link it matches is read through that link.
- A parenthesis among a command's words or against one (`rm @(out)/x`, zsh's `(out)/x`) is an extended glob, not a
  subshell, and asks; zsh's `^src` is read as a wildcard.
- `ln -s` to a target outside the worktree, read from the folder the link is made in, asks: the link isn't on disk
  yet for the rest of its command line to be read through.
