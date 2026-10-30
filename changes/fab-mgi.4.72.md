- The gate's command policy keeps every folder a command may run in: a `cd` adds the folder it lands in and
  drops none, since the gate can't tell which `cd` takes effect (in a subshell, after one that fails, in a
  branch, in a function never called), and a path must stay inside the worktree from each. A `cd` target is
  placed as paths are (every brace alternative, a glob that can match `..` read as `..`); `CDPATH`,
  `cdable_vars`, `cd -`, `popd` and `find -execdir` land in a folder the gate can't tell; `eval`'s `cd` moves
  the shell. A path is outside where any of its brace alternatives is, whatever the others.
