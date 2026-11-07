- The gate asks where bash's arithmetic may run what a variable holds: `$(( ))`, `(( ))`, `let`, a subscript, a slice,
  `[[ -eq ]]`, `[[ -v ]]`, `${!x}` and `declare -i` read a variable's text as an expression, and a subscript in it runs
  commands. It asks when the line holds a value it can't vouch for, or the expression reads a substitution or a parameter.
- Numbers need no asking: counters (`i=$((i+1))`) and substitutions that can only print one (`wc`, `date +%s`, `seq`,
  `nproc`, `grep -c`, `git rev-list --count`, `sysctl -n hw.*`, `getconf`). Others do: `x=$(cat f); echo $((x+1))` and
  `read x < f; echo $((x+1))` now ask, as bash can't tell a number from an expression.
- `OPTIND` and `HISTCMD` ask when given anything but a number, since bash evaluates them on assignment. A quoted word that
  looks like an assignment in a command's place (`"x=2"/../git`) asks, since bash runs it.
