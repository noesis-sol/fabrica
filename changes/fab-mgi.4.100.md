- The gate asks where bash's arithmetic may run what a variable holds: `$(( ))`, `(( ))`, `let`, a subscript, a slice,
  `[[ -eq ]]`, `${!x}` and `declare -i` read a variable's text as an expression, and a subscript in it runs commands. It asks
  when the line gives any variable a value it can't vouch for, or the expression holds a substitution or a parameter. Plain
  numbers and counts (`i=$((i+1))`) need no asking; `n=$(wc -l < f); echo $((n+1))` now does, as bash can't tell them apart.
- A quoted word that looks like an assignment in a command's place (`"x=2"/../git`) asks, since bash runs it.
