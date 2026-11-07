- The gate asks where bash's arithmetic may run what a variable holds: `$(( ))`, `(( ))`, `let`, a subscript, a slice,
  `[[ -eq ]]`, `[[ -v ]]`, `${!x}` and `declare -i` read a variable's text as an expression, and a subscript in it runs
  commands. It asks when a variable read that way has a value on the line it can't vouch for, directly or through the
  variable its value names, or when the expression reads a substitution, a parameter or one of bash's own (`$_`).
- Numbers need no asking: counters (`i=$((i+1))`) and one pipeline that can only print one (`wc`, `date +%s`, `seq`, `nproc`,
  `grep -c`, `git rev-list --count`, `sysctl -n hw.*`, `getconf`). Others do: `x=$(cat f); echo $((x+1))` and
  `read x < f; echo $((x+1))` now ask, as bash can't tell a number from an expression. Variables arithmetic doesn't read don't.
- `OPTIND`, `HISTCMD`, `SRANDOM` and their like ask when given anything but a number, since bash evaluates them on assignment. A quoted word that
  looks like an assignment in a command's place (`"x=2"/../git`) asks, since bash runs it.
