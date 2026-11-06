import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { type Finding, commandFindings } from '../src/gate/commands'

// Lines bash may read otherwise than the gate's reader (spec §12.6). Each of these ran a `git push` on bash
// 3.2 with no findings, or hung the gate. Rather than follow each form, the reader says it doubts the line,
// which asks, and goes on reading it, so what it can read still counts: a refusal stays a refusal.

const context = {
  worktree: '/home/agent/work/fa-1',
  home: Option.none<string>(),
  cdPath: false,
  cdableVariables: false,
}

type Expected = 'allowed' | 'asked' | 'refused'

const outcome = (findings: ReadonlyArray<Finding>): Expected =>
  findings.some(({ _tag }) => _tag === 'Refused' || _tag === 'Push')
    ? 'refused'
    : findings.some(({ _tag }) => _tag === 'Ask')
      ? 'asked'
      : 'allowed'

const lines: ReadonlyArray<readonly [Expected, string]> = [
  // A line continued right after a `$` (fab-mgi.4.93).
  ['asked', "echo $\\\n'\\''; git push origin main #'"],
  ['asked', "$\\\n'git' push origin main"],
  ['asked', "echo $(echo $\\\n'\\''; git push origin main #')"],
  ['asked', "eval \"echo \\$\\\\\n'\\\\''; git push origin main #'\""],
  // A continuation elsewhere reads as it always did.
  ['allowed', 'ls -l \\\n  src'],
  ['refused', 'rm -rf \\\n  /etc/passwd'],
  // Backticks: bash finds their end and unescapes them before reading them (fab-mgi.4.90, 4.93).
  ['asked', "echo `echo $'a`; git push origin main; echo `echo b'`"],
  ['asked', "echo `echo 'a`; git push origin main; echo `echo b'`"],
  ['asked', 'echo `#`; git push origin main\n`'],
  ['asked', 'echo `rm -rf \\$HOME/x`'],
  ['asked', 'echo `cd \\$d; rm -rf y`'],
  ['asked', "echo `eval $'g\\\\c'it push origin main`"],
  ['asked', 'echo `date`'],
  // What can be read beside a backtick still counts.
  ['refused', 'echo `date`; rm -rf /etc/passwd'],
  ['refused', 'echo `date`; git push origin main'],
  // Its modern form is read, and needs no doubt.
  ['allowed', 'echo $(date)'],
  ['refused', 'echo $(rm -rf /etc/passwd)'],
  // A here-document opened in a substitution and left open there (fab-mgi.4.93).
  ['asked', 'echo $(cat <<E)\ngit push origin main\nE'],
  ['asked', 'echo `cat <<E`\ngit push origin main\nE'],
  ['asked', 'cat <(cat <<E)\ngit push origin main\nE'],
  // Closed inside it, it is read.
  ['allowed', 'echo $(cat <<E\nhello\nE\n)'],
  // A comment in a substitution with a quote in it, on bash 3.2's parser (fab-mgi.4.93).
  ['asked', "echo $(# $'\\\n'\ngit push origin main #'\n)"],
  ['asked', "echo $(# it's\nls\n)"],
  ['allowed', 'echo $(# plain words\nls\n)'],
  ['allowed', "ls # it's a comment, outside any substitution"],
  // An unclosed `$(` in backticks ran the gate out of memory (fab-mgi.4.95).
  ['asked', 'echo `echo $(`'],
  ['asked', 'echo `$(`'],
  // A backslash after a non-ASCII character, in a locale the line can set (fab-mgi.4.96).
  ['asked', "export LC_ALL=ja_JP.SJIS\necho $'あ\\'; git push origin main #'"],
  ['asked', 'export LC_ALL=zh_TW.Big5\necho "あ\\"; git push origin main #"'],
  ['asked', 'export LC_CTYPE=ja_JP.SJIS\necho あ\\; git push origin main'],
  ['asked', "echo $'あ\\'; git push origin main #'"],
  ['allowed', 'echo "héllo wörld"'],
  ['allowed', 'LC_ALL=C sort notes.txt'],
  // Shells that read a script otherwise than bash (fab-mgi.4.94).
  ['asked', "dash -c \"echo \\$'a\\\\'; git push origin main; echo '' #'\""],
  ['asked', "sh -c \"echo \\$'a\\\\'; git push origin main; echo '' #'\""],
  ['asked', 'zsh -c "ls"'],
  ['asked', 'ksh -c "ls"'],
  ['allowed', 'sh -c "ls"'],
  ['allowed', 'bash -c "ls"'],
  ['refused', 'sh -c "rm -rf /etc/passwd"'],
  ['refused', 'zsh -c "rm -rf /etc/passwd"'],
  // A here-document's delimiter with a $ still expands its body, and a continued line is joined (fab-mgi.4.91).
  ['asked', ': <<$E\n$(rm -rf /)\n$E'],
  ['asked', ': <<${E}\n$(rm -rf /)\n${E}'],
  ['asked', ': <<E\n$\\\n(rm -rf /)\nE'],
  ['allowed', ": <<'E'\n$(rm -rf /)\nE"],
  ['allowed', ': <<\\E\n$(rm -rf /)\nE'],
  // A command's name spelled by brace expansion (fab-mgi.4.86).
  ['refused', '{sudo,true} ls'],
  ['refused', '{git,push} origin'],
  ['asked', 'git {push,status} origin'],
  ['asked', '{ls,-l} src'],
  ['refused', 'command {sudo,true} ls'],
  ['refused', 'FOO=1 {sudo,true} ls'],
  ['allowed', '{ ls; }'],
  ['allowed', 'ls {src,test}'],
]

describe('a line the gate doubts', () => {
  for (const [expected, command] of lines)
    it(`${expected}: ${JSON.stringify(command)}`, () => {
      expect(outcome(commandFindings(command, context))).toBe(expected)
    })
})
