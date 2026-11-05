import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { readEnvironment } from '../src/environment'
import {
  type CommandContext,
  type Finding,
  commandFindings,
} from '../src/gate/commands'

// Where `cd` and `~` land when the agent's environment or the command line moves them (spec §12.6,
// §20.2): a `CDPATH` or `cdable_vars` the shell inherits sends a `cd` where the gate can't tell, and
// a command line that sets `HOME`, or a variable whose name is known only when it runs, leaves `~`,
// `$HOME` and a bare `cd` unknown.

const worktree = '/home/agent/work/fa-1'

type Expected = 'allowed' | 'asked' | 'refused'

/** What the gate's `workspace` level makes of `findings`. */
const outcome = (findings: ReadonlyArray<Finding>): Expected =>
  findings.some(({ _tag }) => _tag === 'Refused' || _tag === 'Push')
    ? 'refused'
    : findings.some(({ _tag }) => _tag === 'Ask')
      ? 'asked'
      : 'allowed'

const context = (shell: Partial<CommandContext> = {}): CommandContext => ({
  worktree,
  home: Option.some('/home/agent'),
  cdPath: false,
  cdableVariables: false,
  ...shell,
})

const lines: ReadonlyArray<
  readonly [Expected, string, Partial<CommandContext>]
> = [
  // A `CDPATH` from the environment sends a searched `cd` target under one of its folders.
  ['allowed', 'cd x; rm -rf y', {}],
  ['asked', 'cd x; rm -rf y', { cdPath: true }],
  ['asked', 'cd "$d"; rm -rf y', { cdPath: true }],
  ['allowed', 'cd ./x; rm -rf y', { cdPath: true }],
  ['allowed', `cd ${worktree}/x; rm -rf y`, { cdPath: true }],
  // `cdable_vars` from the environment sends any `cd` target where a variable names.
  ['asked', 'cd ./x; rm -rf y', { cdableVariables: true }],
  // A loop's variable is set as an assignment is.
  ['asked', 'for CDPATH in ..; do cd x; rm -rf y; done', {}],
  // A command line that sets `HOME` moves `~`, `$HOME` and a bare `cd`.
  ['allowed', 'rm -rf ~/work/fa-1/build', {}],
  ['asked', 'HOME=/; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'export HOME=/; rm -rf $HOME/work/fa-1/build', {}],
  ['asked', 'HOME=/; cd; rm -rf work/fa-1/build', {}],
  ['asked', 'HOME=.. cd; rm -rf x', {}],
  ['asked', 'unset HOME; cd ~; rm -rf x', {}],
  ['asked', 'for HOME in /; do rm -rf ~/work/fa-1/build; done', {}],
  ['asked', "bash -c 'HOME=/; rm -rf ~/work/fa-1/build'", {}],
  // A variable whose name is known only when it runs may be any of them.
  ['asked', 'declare "${v}PATH=.."; cd x; rm -rf y', {}],
  ['asked', 'read "$v"; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'printf -v "$v" /; cd; rm -rf work/fa-1/build', {}],
  ['asked', 'export $v; cd x; rm -rf y', {}],
  ['asked', '{decl,x}are "$v"; rm -rf ~/work/fa-1/build', {}],
  // ANSI-C quoting may spell a name, or a path, with escapes.
  ['asked', "export $'HO\\x4dE'=/; rm -rf ~/work/fa-1/build", {}],
  ['asked', "export $'HO\\115E'=/; rm -rf ~/work/fa-1/build", {}],
  ['asked', "declare $'CD\\x50ATH'=..; cd x; rm -rf y", {}],
  ['refused', "rm -rf $'\\x2e\\x2e/x'", {}],
  ['refused', "cd $'\\056\\056'; rm -rf x", {}],
  ['allowed', "rm -rf $'\\x2e/x\\0/../../..'", {}],
  // `\x{…}` and `$"…"` may spell a name or a path as well.
  ['asked', "export $'HO\\x{4d}E'=/; rm -rf ~/work/fa-1/build", {}],
  ['asked', "declare $'CD\\x{50}ATH'=..; cd x; rm -rf y", {}],
  ['refused', "rm -rf $'\\x{2e}\\x{2e}/x'", {}],
  ['refused', "rm -rf $'..\\x{2f}x'", {}],
  ['refused', "cd $'\\x{2e}\\x{2e}'; rm -rf x", {}],
  ['asked', 'export HO$"M"E=/; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'declare CD$"PATH"=..; cd x; rm -rf y', {}],
  ['refused', 'rm -rf $"../x"', {}],
  ['refused', 'cd $".."; rm -rf x', {}],
  ['allowed', 'echo "$"; rm -rf y', {}],
  // `printf -v`'s name, attached and known only when it runs, or an option itself.
  ['asked', 'printf -v"$v" /; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'printf -v$v /; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'printf -v"${v}PATH" ..; cd x; rm -rf y', {}],
  ['asked', 'command printf -v"$v" /; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'printf "$o" /; rm -rf ~/work/fa-1/build', {}],
  // An assignment in a redirection's word or a here-document's body sets as one in a command's.
  ['asked', ': <<< ${CDPATH:=..}; cd x; rm -rf y', {}],
  ['asked', ': < ${CDPATH:=..}; cd x; rm -rf y', {}],
  ['asked', ': > ${HOME:=/dev/null}; rm -rf ~/work/fa-1/build', {}],
  ['asked', ': <<EOF\n${CDPATH:=..}\nEOF\ncd x; rm -rf y', {}],
  ['asked', ': <<EOF\n$((HOME=1))\nEOF\nrm -rf ~/work/fa-1/build', {}],
  ['allowed', ": <<'EOF'\n${CDPATH:=..}\nEOF\ncd x; rm -rf y", {}],
  ['allowed', ': <<EOF\nHOME is $USER\nEOF\nrm -rf ~/work/fa-1/build', {}],
  // An option or an indirection known only when it runs may turn any of them on.
  ['asked', 'shopt -s "$o"; cd x; rm -rf y', {}],
  ['asked', 'bash -O "$o" -c \'cd x; rm -rf y\'', {}],
  ['asked', ': ${!v:=/}; rm -rf ~/work/fa-1/build', {}],
  // A nameref is asked about wherever it is, what follows it read or not.
  ['asked', 'declare -n r; r=$v; rm -rf y', {}],
  ['asked', 'declare -n r=HOME', {}],
  ['asked', 'declare -in r; ls', {}],
  ['asked', 'builtin declare -n r; ls', {}],
  ['asked', '{decl,x}are -n r; ls', {}],
  ['asked', 'declare {-n,-x} r; ls', {}],
  ['asked', "eval 'declare -n r'; ls", {}],
  ['asked', 'declare $o r; ls', {}],
  ['asked', 'declare -$o r; ls', {}],
  // Its name and `-n` only count as a command's: other words that read the same set nothing.
  ['allowed', 'grep -n local src/x.ts', {}],
  ['allowed', 'grep -n declare src/x.ts; rm -rf ~/work/fa-1/build', {}],
  ['allowed', 'echo read "$x"; rm -rf ~/work/fa-1/build', {}],
  ['allowed', 'export -n X; ls', {}],
  ['allowed', 'declare -x X="$y"; ls', {}],
  // A name made to refer to another variable sets that one.
  ['asked', 'declare -n r="$v"; r=/; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'typeset -n r="$v"; r=..; cd x; rm -rf y', {}],
  ['asked', 'local -gn r; r=$v; rm -rf ~/work/fa-1/build', {}],
  // Brace expansion may spell a name.
  ['asked', 'export {HO,X}ME=/; rm -rf ~/work/fa-1/build', {}],
  ['asked', 'export {CD,X}PATH=..; cd x; rm -rf y', {}],
  ['allowed', 'export HO\\{M,X}E=/; rm -rf ~/work/fa-1/build', {}],
  // Set in a nested script after the commands it moves, it still moves them.
  [
    'asked',
    `for i in 1 2; do rm -rf ~/work/fa-1/build; eval 'read "$v"'; done`,
    {},
  ],
  // A variable named where it is written moves nothing else.
  ['refused', 'export PATH="$PATH:/opt/bin"; cd sub; rm -rf ../../y', {}],
  ['refused', 'read -r line; cd sub; rm -rf ../../y', {}],
  ['refused', 'printf "%s" "$x"; rm -rf ~/x', {}],
]

describe('the shell’s environment', () => {
  for (const [expected, command, shell] of lines)
    it(`${expected}: ${command} ${JSON.stringify(shell)}`, () => {
      expect(outcome(commandFindings(command, context(shell)))).toBe(expected)
    })

  it('reads CDPATH and cdable_vars from the agent’s environment', () => {
    const read = (variables: Readonly<Record<string, string>>) => {
      const { cdPath, cdableVariables } = readEnvironment(variables, worktree)
      return { cdPath, cdableVariables }
    }
    expect(read({})).toEqual({ cdPath: false, cdableVariables: false })
    expect(read({ CDPATH: '' })).toEqual({
      cdPath: false,
      cdableVariables: false,
    })
    expect(read({ CDPATH: '..:/tmp' })).toEqual({
      cdPath: true,
      cdableVariables: false,
    })
    expect(read({ BASHOPTS: 'checkwinsize:cdable_vars' })).toEqual({
      cdPath: false,
      cdableVariables: true,
    })
  })
})
