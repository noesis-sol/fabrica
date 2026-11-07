- The gate asks about a script it can't read that the line itself makes reachable: one from `/dev/stdin`, a process
  substitution or anywhere outside the worktree, `bash -s`, `--rcfile`, one the line wrote, and a shell or `source` looking
  a bare name up on a `PATH` the line sets. Running what the line wrote by name (`./s`) asks too. A script already in the
  worktree still runs without asking, however it got there.
- It also asks about `alias` definitions, `expand_aliases`, `BASH_ENV`, `ENV`, `PS1`, `PS4`, `PROMPT_COMMAND`, builtins that
  run text they're given (`compgen -C`, `mapfile -C`, `hash -p`, `fc`), and setters naming a variable only when they run.
