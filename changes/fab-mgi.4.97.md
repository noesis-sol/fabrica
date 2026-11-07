- The gate asks about a script it can't read that the line makes reachable: one from `/dev/stdin`, a process substitution or
  a name known only when it runs, a shell's input whatever options it's given, `--rcfile`, one the line wrote, under any
  spelling or through a link, and one a shell or `source` looks up on a `PATH` the line sets. Running by name what the line
  wrote asks too. A script already on disk still runs without asking, however it got there.
- It also asks about `alias` definitions, `expand_aliases`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `PS1`, `PS4`, `PROMPT_COMMAND`, a
  shell reading its startup files from a home folder the line sets, builtins that run or expand text they're given
  (`compgen -C` and `-W`, `mapfile -C`, `hash -p`, `fc`, `declare`'s array values) and setters naming a variable only when
  they run. It reads a shell's `-c` script past options that take a value, and `csh`, `tcsh` and `fish` as shells it asks about.
