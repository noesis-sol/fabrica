- The gate reads where `cd` and `~` land as the agent's shell does (§12.6, §20.2): a `CDPATH` in the agent's
  environment, or `cdable_vars` turned on by `BASHOPTS`, sends a `cd` target it searches to a folder the gate
  can't tell; a command line that sets `HOME` (an assignment, `export`, `unset`, a `for` loop's variable) leaves
  `~`, `$HOME` and a bare `cd` unknown, a name spelled by brace expansion (`export {HO,X}ME=/`) included;
  and a variable whose name is known only when it runs (`declare "${v}PATH=.."`, `read "$v"`, `printf -v "$v"`) may
  be any of them; a nameref (`declare -n r`, or a dynamic option or operand to `declare`, `typeset` or `local`, which
  may be one) moves them too and asks, whatever follows it. Set in an `eval` or `bash -c` after the
  commands it moves, it still moves them.
- The gate decodes ANSI-C quoting as bash does (`\x2e`, `\x{2e}`, `\056`, `\u…`, `\cx`, a NUL ending the string) and
  reads `$"…"` as a double-quoted string, so
  `$'HO\x4dE'=/` sets `HOME` and `rm -rf $'\x2e\x2e/x'` removes outside the worktree in the gate's reading too.
  A character code still asks, whatever it decodes to, and the string ends where bash ends it, so `\c` before a
  closing quote hides nothing after it.
- An assignment in a redirection's word or an expanding here-document's body (`: <<< ${CDPATH:=..}`) moves `cd` and
  `~` as one in a command's word does, and a `shopt`, `bash -O` or `${!v:=x}` known only when it runs may be any of
  them.
