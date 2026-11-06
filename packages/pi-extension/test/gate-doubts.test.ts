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
  // A continuation in a here-document's delimiter or its body, which bash joins first.
  ['asked', 'cat <<E\\\nF\n$(git push origin main)\nEF'],
  ['asked', 'cat <<\\\nE\n$(git push origin main)\nE'],
  ['asked', 'cat <<E\\\n\n$(git push origin main)\nE'],
  ['asked', 'cat <<EF\nE\\\nF\ngit push origin main\nEF'],
  ['asked', 'cat <<EF\nE\\\nF\ngit push origin main'],
  ['asked', 'cat <<-EF\n\tE\\\nF\ngit push origin main\nEF'],
  // An outer here-document, then a line break inside a substitution: bash reads its body from there.
  ['asked', 'cat <<E $(echo a\ngit push origin main\nE\n)\nb\nE'],
  ['asked', 'cat <<E && echo $(\ngit push origin main\nE\n)\nb\nE'],
  ['asked', 'cat <<E; echo $(echo a\ngit push origin main\nE\n)\nb\nE'],
  ['asked', 'cat <<E <(\ngit push origin main\nE\n)\nb\nE'],
  ['asked', 'echo <<E $(echo a; \ngit push origin main\nE\n)'],
  // With no line break in the substitution, it takes nothing of the body.
  ['allowed', 'cat <<E $(echo a)\nhello\nE'],
  // A here-document's body with a `)` of its own, where bash 3.2 ends the substitution.
  ['asked', 'echo $(cat <<E\n)\ngit push origin main\nE\n)'],
  ['asked', "echo $(cat <<'E'\n)\ngit push origin main\nE\n)"],
  ['asked', 'x=$(cat <<E\n);git push origin main\nE\n)'],
  ['asked', 'echo <(cat <<E\n)\ngit push origin main\nE\n)'],
  // Parentheses that balance, as a commit message's do, end nothing.
  [
    'allowed',
    'git commit -m "$(cat <<\'EOF\'\nfix(gate): read it (again)\nEOF\n)"',
  ],
  // A `#` after an escaped blank in a substitution, a comment on bash 3.2.
  ['asked', "echo $(echo \\ #'\n);git push origin main #'\n)"],
  ['asked', "echo $(echo a\\ #'\n);git push origin main\n#'\n)"],
  // A `$((` that closes early is a command substitution to bash.
  ['asked', 'echo $((echo a);git push origin main;(echo b))'],
  ['asked', 'echo $((:);git push origin main;(:))'],
  ['asked', 'echo "$((echo a);git push origin main;(echo b))"'],
  ['asked', 'echo $((git push origin main);(echo b))'],
  ['asked', 'echo $((git push origin main) ) ; ((1))'],
  ['asked', 'echo ${x:-$((echo a);git push origin main;(echo b))}'],
  ['allowed', 'echo $((1 + (2 * 3)))'],
  // `for` or `select` with no `in`: its body starts on the same line.
  ['refused', 'set -- 1; for x do git push origin main; done'],
  ['refused', 'set -- 1; for x do git push origin main\ndone'],
  ['refused', 'set -- 1; for x do { git push origin main; }; done'],
  ['refused', 'for x { git push origin main; }'],
  ['refused', 'select x do git push origin main; break; done <<< 1'],
  ['refused', 'f() { for x do git push origin main; done; }; f 1'],
  ['refused', 'for x in a b; do git push origin main; done'],
  ['allowed', 'for x in a b; do ls "$x"; done'],
  // A `<<` in `$[…]` or a subscript shifts, and opens no here-document.
  ['asked', 'a[1<<2]=1\ngit push origin main'],
  ['asked', 'echo $[1<<2]\ngit push origin main'],
  ['asked', 'echo $[<<E]\ngit push origin main'],
  ['allowed', 'cat<<E\nhello\nE'],
  // A name past what the gate expands.
  ['asked', '{git,push,origin,main,z{0,1}{0,1}{0,1}{0,1}{0,1}{0,1}{0,1}{0,1}}'],
  // What these rules mustn't catch: a backslash after a wide character means nothing in single quotes, and in
  // double quotes only before what it escapes there.
  ['allowed', "sed 's/é\\//x/' a.ts"],
  ['allowed', "grep -rn '§\\.\\|§ 12' docs/"],
  ['allowed', 'grep -n "→\\s" a.md'],
  ['allowed', 'echo "日本語\\n"'],
  // A comment with an apostrophe in a plain subshell, read alike by every bash.
  ['allowed', "( # don't touch the lockfile\n ls\n)"],
  // A `$'` that is no quote to bash: the `$` ends a pattern.
  ['allowed', 'sh -c "grep \'^foo$\' a.txt"'],
  ['allowed', 'sh -c \'grep "foo$" a.txt\''],
  // A continued line inside a reserved word leaves it reserved.
  ['refused', 'i\\\nf git push origin main; then :; fi'],
  ['refused', 'if :; t\\\nhen git push origin main; fi'],
  ['refused', 'if false; then :; e\\\nlse git push origin main; fi'],
  ['refused', 'w\\\nhile git push origin main; do break; done'],
  ['refused', 'for x in a; d\\\no git push origin main; done'],
  ['refused', '!\\\n git push origin main'],
  ['refused', 'f\\\nunction f { git push origin main; }; f'],
  ['refused', 'set -- 1; for x do\\\n git push origin main; done'],
  // Bash 3.2's end of a substitution, by a quote the body leaves open, a comment, `$'…'` or a backtick.
  ['asked', "echo $(cat <<E\n'\nE\n'); git push origin main #'\n)"],
  ['asked', "echo $(cat <<E\nit's\nE\n'); git push origin main #'\n)"],
  ['asked', 'echo $(cat <<E\n"\nE\n"); git push origin main #"\n)'],
  ['asked', "echo $(cat <<E\n# it's\n)\ngit push origin main\nE\n)"],
  ['asked', "echo $(cat <<E\na # it's\n)\ngit push origin main\nE\n)"],
  ['asked', "x=$(cat <<'E'\n#(\n);git push origin main\nE\n)"],
  ['asked', "echo $(cat <<E\n$'\\''\n)\ngit push origin main\nE\n)"],
  ['asked', "echo $(cat <<'E'\n`'`\n)\ngit push origin main\nE\n)"],
  // Where it ends where the reader does, nothing asks, as commit messages need.
  [
    'allowed',
    "git commit -m \"$(cat <<'EOF'\nit's what we want, and that's all\nEOF\n)\"",
  ],
  ['allowed', "git commit -m \"$(cat <<'EOF'\nit's\nEOF\n)\""],
  ['allowed', 'git commit -m "$(cat <<\'EOF\'\n# heading\nEOF\n)"'],
  [
    'allowed',
    "x=$(\n  # the head's commit, as it's what we want\n  git rev-parse HEAD\n)",
  ],
  // An array's subscript still open, by a blank or a separator in it.
  ['asked', 'a[1 <<2]=1\ngit push origin main'],
  ['asked', 'a[ 1<<2 ]=1\ngit push origin main'],
  ['asked', 'a[1|1<<2]=1\ngit push origin main'],
  ['asked', 'a[1&&1<<2]=1\ngit push origin main'],
  ['asked', 'x=1 a[1 <<2]=1\ngit push origin main'],
  ['allowed', 'a[1]=2'],
  ['allowed', 'grep a[b] notes.txt'],
  // A wide character's backslash in an expansion and a here-document in a substitution.
  [
    'asked',
    'export LC_ALL=ja_JP.SJIS\necho ${x:-あ\\}; git push origin main #}',
  ],
  [
    'asked',
    'export LC_ALL=ja_JP.SJIS\necho $(cat <<E\nあ\\)\ngit push origin main\nE\n)',
  ],
  // Coproc, on the bash that has it.
  ['refused', 'coproc git push origin main'],
  ['asked', 'coproc x { git push origin main; }'],
]

describe('a line the gate doubts', () => {
  for (const [expected, command] of lines)
    it(`${expected}: ${JSON.stringify(command)}`, () => {
      expect(outcome(commandFindings(command, context))).toBe(expected)
    })
})
