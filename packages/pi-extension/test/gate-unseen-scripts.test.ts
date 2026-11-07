import { Effect, Option } from 'effect'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { tempFolder } from '@fabrica/testkit'

import { type Finding, commandFindings } from '../src/gate/commands'

// Commands the gate can't read on the line, though bash runs them: from a file the line wrote or names
// somewhere it can't look (fab-mgi.4.97), or from a variable's text, which arithmetic evaluates and whose
// subscript runs what it holds (fab-mgi.4.100). Each of the lines marked below ran a `git push` on bash 3.2
// with no findings. The gate can't follow them, so it asks; what it can read still counts.

const push = 'git push origin main'

const context = {
  worktree: '/work/fa-1',
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

const written = `echo '${push}' > s; `
const held = `x='b[$(${push})]'; `

/** Lines that push, on the bash that runs them, unless noted. */
const hidden: ReadonlyArray<string> = [
  // A script from somewhere the gate can't look.
  `bash /dev/stdin <<< '${push}'`,
  `bash <(echo '${push}')`,
  `. /dev/stdin <<< '${push}'`,
  `source /dev/stdin <<< '${push}'`,
  `bash -- /dev/stdin <<< '${push}'`,
  `bash - /dev/stdin <<< '${push}'`,
  `bash -o pipefail /dev/stdin <<< '${push}'`,
  `bash /dev/std{in,} <<< '${push}'`,
  `bash /dev/std?n <<< '${push}'`,
  `bash /tmp/../dev/stdin <<< '${push}'`,
  `bash -s x <<< '${push}'`,
  `bash -es x <<< '${push}'`,
  `PATH=/dev:$PATH . stdin <<< '${push}'`,
  `PATH=/dev:$PATH; bash stdin <<< '${push}'`,
  // A script the line wrote.
  `${written}bash s`,
  `${written}. s`,
  `${written}bash ./s`,
  `${written}bash s -c ls`,
  `${written}bash s*`,
  `${written}f=s; bash $f`,
  `${written}exec bash s`,
  `${written}command . s`,
  `${written}eval '. s'`,
  `${written}xargs bash <<< s`,
  `${written}mv s t; bash t`,
  `${written}cp s t; bash t`,
  `${written}chmod +x s; ./s`,
  `${written}chmod +x s; PATH=. s`,
  `cat > s <<E\n${push}\nE\nbash s`,
  `tee s <<< '${push}' >/dev/null; sh s`,
  `mkdir d; echo '${push}' > d/s; bash d/s`,
  `mkdir d; cd d; echo '${push}' > s; cd ..; bash d/s`,
  `echo '${push}' > $PWD/s; bash s`,
  // A file a shell starts from.
  `${written}BASH_ENV=s bash -c true`,
  `${written}env BASH_ENV=s bash -c true`,
  `${written}export BASH_ENV=s; bash -c true`,
  `${written}bash --rcfile s -i </dev/null`,
  `${written}bash --init-file s -i </dev/null`,
  `v=BASH_ENV; declare "$v=s"; ${written}bash -c true`,
  // Text a variable or builtin runs.
  `PS4='$(${push})'; set -x; ls >/dev/null`,
  `PS4='$(${push})' bash -xc true`,
  `read PS4 <<< '$(${push})'; set -x; :`,
  `sh -c "alias x='${push}'\nx"`,
  `shopt -s expand_aliases\nalias x='${push}'\nx`,
  `shopt -s expand_aliases\ncommand alias x='${push}'\nx`,
  `compgen -C '${push}'`,
  `hash -p ./s ls; ${written}chmod +x s; ls`,
  // Arithmetic re-reading a variable.
  `${held}echo $((x))`,
  `${held}echo "$((x))"`,
  `${held}(( x ))`,
  `${held}let x`,
  `${held}command let x`,
  `${held}eval 'let x'`,
  `${held}echo \${a[x]}`,
  `${held}echo \${#a[x]}`,
  `${held}a[x]=1`,
  `${held}declare a[x]=1`,
  `${held}[[ $x -eq 0 ]]`,
  `${held}[[ 1 -eq x ]]`,
  `${held}s=abc; echo \${s:x}`,
  `${held}for ((i=x;i<0;i++)); do :; done`,
  `${held}cat <<E\n\${a[x]}\nE`,
  `${held}export x; bash -c '(( x ))'`,
  `x='a[$(${push})]'; echo \${!x}`,
  `x='b[\`${push}\`]'; echo $((x))`,
  // A value built where the gate can't see its text.
  `d='$'; x="b[\${d}(${push})]"; echo $((x))`,
  `x=$(printf 'b\\x5b\\x24(${push})]'); echo $((x))`,
  `x='b['; y='$(${push})]'; z=$x$y; echo $((z))`,
  `y='b[$(${push})]'; x=y; echo $((x))`,
  `read x <<< 'b[$(${push})]'; echo $((x))`,
  `for x in 'b[$(${push})]'; do echo $((x)); done`,
  `printf -v x %s 'b[$(${push})]'; echo $((x))`,
  `echo 'b[$(${push})]' > f; read x < f; echo $((x))`,
  `x='b[$(${push})]' bash -c 'echo $((x))'`,
  `env x='b[$(${push})]' bash -c 'echo $((x))'`,
  // The expression's own text.
  `echo $(( $(echo 'b[$(${push})]') ))`,
  `set -- 'b[$(${push})]'; echo $(($1))`,
  `set -- 'b[$(${push})]'; [[ $1 -eq 0 ]]`,
  `set -- 'b[$(${push})]'; let $1`,
  `f() { echo $(($1)); }; f 'b[$(${push})]'`,
  `bash -c 'echo $(($1))' _ 'b[$(${push})]'`,
  // Integers evaluate what they are given.
  `declare -i n='b[$(${push})]'`,
  `declare -i n; n='b[$(${push})]'`,
  `typeset -i n='b[$(${push})]'`,
  // A name bash reads through.
  `read 'a[$(${push})]' <<< 1`,
  `declare 'a[$(${push})]=1'`,
  `a=(1); x='a[$(${push})]'; unset "$x"`,
  // A shell's input, past options that take a value.
  `bash -euo pipefail <<'E'\n${push}\nE`,
  `echo '${push}' | bash -eo pipefail`,
  `bash -O extglob <<< '${push}'`,
  `sh -o errexit <<< '${push}'`,
  `bash - <<< '${push}'`,
  `echo '${push}' | sh -`,
  `echo ${push} | bash +e`,
  // A shell's script, past the same.
  `bash -c -o pipefail '${push}'`,
  `bash -ceo pipefail '${push}'`,
  `bash -c -O extglob '${push}'`,
  `bash -c +x '${push}'`,
  // Spelled another way, on a volume that folds case or normalizes names.
  `${written}bash S`,
  `${written}chmod +x s; ./S`,
  `mkdir D; echo '${push}' > D/s; bash d/s`,
  // Through a link.
  `ln -s s t; echo '${push}' > t; bash s`,
  `ln -s . e; echo '${push}' > e/s; bash s`,
  // One command writing and running.
  `find . -maxdepth 0 -exec tee s ';' -exec bash s ';' <<< '${push}'`,
  `find . -maxdepth 0 -exec sh -c "echo '${push}' > s" ';' -exec bash s ';'`,
  `${written}xargs -I{} bash {} <<< s`,
  `${written}xargs -J% bash % <<< s`,
  // A name on a PATH the line sets, a home folder the line sets.
  `mkdir b; echo '${push}' > b/foo; chmod +x b/foo; PATH=b:$PATH foo`,
  `echo '${push}' > .bashrc; HOME=. bash -ic true`,
  `echo '${push}' > .bashrc; export HOME=.; bash -ic true`,
  // Names attached, or assigned in an expansion.
  `printf -vPATH %s "/dev:$PATH"; . stdin <<< '${push}'`,
  `printf -vPS4 '$(${push})'; set -x; :`,
  `${written}set -a; : \${BASH_ENV:=s}; bash -c true`,
  // Text builtins expand.
  `compgen -W '$(${push})'`,
  `declare -a 'a=($(${push}))'`,
  `a='($(${push}))'; declare -a b=$a`,
  `read a <<< '($(${push}))'; declare -a b=$a`,
  // Text the line holds, reaching arithmetic by a way the gate doesn't name.
  `a=('1+b[$(${push})]'); echo $((a))`,
  `: '1+b[$(${push})]'; echo $((_))`,
  `bash -c 'echo $(($0))' '1+b[$(${push})]'`,
  `[[ '1+b[$(${push})]' =~ .* ]]; echo $((BASH_REMATCH))`,
  `set -- '1+b[$(${push})]'; for v; do echo $((v)); done`,
  `set -- '1+b[$(${push})]'; echo $(( \${!#} ))`,
  `touch '1+b[$(${push})]'; for f in *; do echo $((f)); done`,
  // Arithmetic the first reading missed.
  `${held}(( ((1)) + x ))`,
  `${held}[[ ( x -eq 0 ) ]]`,
  `${held}[[ a && x -eq 0 ]]`,
  `${held}set -- abc; echo \${1:x}`,
  `${held}cat <<E\n$[x]\nE`,
  `${held}cat <<E\n\${z:-\${a[x]}}\nE`,
  `set -- '+b[$(${push})]'; x=$((1))$1"))"; echo $((x))`,
  // Evaluated when they're assigned.
  `OPTIND='1+b[$(${push})]'`,
  `read OPTIND <<< '1+b[$(${push})]'`,
  `HISTCMD='1+b[$(${push})]'`,
  // Other shells, whose grammar the gate doesn't know.
  `csh -c '${push}'`,
  `echo '${push}' | csh`,
]

/** Lines that may push on some bash, which only running them tells: checked below on the bash at hand. */
const onSomeBash: ReadonlyArray<string> = [
  `x='$(${push})'; echo \${x@A}`,
  `x='$(${push})'; echo \${x@E}`,
  `x='$(${push})'; echo \${x@P}`,
  `echo \${ ${push}; }`,
  `echo \${| ${push}; }`,
  `EPOCHSECONDS='1+b[$(${push})]'`,
  `SRANDOM='1+b[$(${push})]'`,
  `BASHPID='1+b[$(${push})]'`,
  `COMP_LINE='1+b[$(${push})]'`,
  `BASH_ARGV0='1+b[$(${push})]'; echo $(($0))`,
  `BASH_COMPAT=3.2; x='1+b[$(${push})]'; [[ $x -eq 0 ]]`,
  `shopt -s compat31; x='1+b[$(${push})]'; echo $x`,
  `x='a[$(${push})]'; wait -p "$x"`,
  `x='a[$(${push})]'; [[ -v $x ]]`,
  `x='a[$(${push})]'; test -v "$x"`,
  `declare 'a=($(${push}))'`,
  `declare 'a[0]=$(${push})'`,
  `printf -v'a[$(${push})]' %s 1`,
  `read -ra'a[$(${push})]' <<< 1`,
  `mapfile -C '${push} #' -c1 a <<< x`,
  `set -o history; history -s '${push}'; fc -s git`,
  `${written}chmod +x s; BASH_CMDS[ls]=./s; ls`,
]

/** Lines bash runs alike on what the gate reads, or that nothing on the line could change. */
const lines: ReadonlyArray<readonly [Expected, string]> = [
  // A script already in the worktree is left to run, as a program is.
  ['allowed', 'bash scripts/check-fast.sh'],
  ['allowed', 'sh ./scripts/x.sh a "$b"'],
  ['allowed', 'bash -x scripts/x.sh'],
  ['allowed', '. ./env.sh'],
  ['allowed', 'chmod +x scripts/x.sh; ./scripts/x.sh'],
  ['allowed', 'mkdir -p out; bash scripts/x.sh'],
  // Its own output isn't what it runs.
  ['allowed', 'bash scripts/x.sh > build.log 2>&1'],
  ['allowed', './scripts/x.sh > build.log'],
  ['allowed', 'echo hello > out.txt; bash scripts/x.sh'],
  ['allowed', 'echo hello > out.txt; ls'],
  // A shell's own command is still read.
  ['allowed', 'bash -c "ls"'],
  ['refused', `bash -c "${push}"`],
  ['refused', `bash s -c "${push}"`],
  ['refused', `${written}${push}`],
  // Numbers need no doubt.
  ['allowed', 'echo $((1 + 2))'],
  ['allowed', 'i=0; i=$((i + 1)); echo $i'],
  ['allowed', 'i=0; while [ $i -lt 3 ]; do i=$((i+1)); done'],
  ['allowed', 'for ((i = 0; i < 3; i++)); do echo $i; done'],
  ['allowed', 'for i in 1 2 3; do echo $((i * 2)); done'],
  ['allowed', 'n=5; echo ${a[n]}; let n=n+1; (( n > 1 ))'],
  ['allowed', 'rc=$?; [[ $rc -ne 0 ]]'],
  ['allowed', 'echo $((FABRICA_CORES / 2))'],
  ['allowed', 'n=${#a[@]}; echo $((n - 1))'],
  ['allowed', 'echo ${a[@]} ${#a[@]} ${s:0:2}'],
  ['allowed', 'echo $(($# - 1))'],
  // A value alone reads nothing again, nor does `[`.
  ['allowed', 'x=$(git rev-parse HEAD); echo "$x"'],
  ['allowed', `x='b[$(${push})]'; echo "$x"`],
  ['allowed', `x='b[$(${push})]'; [ "$x" -eq 0 ]`],
  ['allowed', `x='b[$(${push})]'; test "$x" -eq 0`],
  // A substitution that can only print a number.
  ['allowed', 'n=$(wc -l < notes.txt); echo $((n + 1))'],
  ['allowed', 'echo $(( $(wc -l < notes.txt) + 1 ))'],
  ['allowed', 'n=$(grep foo a | wc -l); (( n > 3 ))'],
  ['allowed', 'start=$(date +%s); ls; echo $(( $(date +%s) - start ))'],
  ['allowed', 'for i in $(seq 1 3); do echo $((i * 2)); done'],
  ['allowed', 'echo $(($(nproc) / 2))'],
  ['allowed', 'cores=$(sysctl -n hw.ncpu); echo $((cores / 2))'],
  ['allowed', 'arr=(a b c); for i in "${!arr[@]}"; do echo "${arr[i]}"; done'],
  ['allowed', 'v=${BASH_VERSINFO[0]}; (( v >= 4 ))'],
  // Any other: bash can't be told a count from an expression, and a file's text may be one.
  ['asked', 'x=$(cat notes.txt); echo $((x + 1))'],
  ['asked', 'read -r x < notes.txt; echo $((x + 1))'],
  ['asked', 'n=$(echo 5 | cat); (( n > 3 ))'],
  // Words shaped like a subscript, to commands that don't evaluate them.
  ['allowed', `awk 'a[$1]' a.txt`],
  ['allowed', 'echo "foo[$1]"'],
  ['allowed', 'grep "x[$1]" notes.txt'],
  // A script outside the worktree: nothing on the line can have written it, and writing it would have asked.
  ['allowed', 'source /etc/profile'],
  ['allowed', '. /opt/homebrew/opt/nvm/nvm.sh'],
  ['allowed', 'zsh /tmp/merge-all.sh a b'],
  // A placeholder's `>` before a line break names no file.
  ['allowed', 'bd show <issue-id>\nls'],
  // What can be read beside these still counts.
  ['refused', `${held}echo $((x)); ${push}`],
  ['refused', `bash /dev/stdin <<< x; ${push}`],
  ['refused', `alias x=y; rm -rf /etc/passwd`],
  // A quoted word bash takes for a command, not an assignment.
  ['asked', `"x=2"/../git push origin main`],
  ['asked', `"x=2" ls`],
  ['allowed', 'x=2 ls'],
  ['allowed', 'env "x=2" ls'],
  // Unset and quotes in commit messages aren't what's asked about.
  ['allowed', 'git commit -m "ENV handling"'],
  ['allowed', 'echo NODE_ENV=production'],
  ['allowed', 'NODE_ENV=production ls'],
  ['allowed', 'export FOO="$bar"'],
  // Setters that name a variable only when they run.
  ['asked', 'export $(grep -v "^#" .env | xargs)'],
  ['allowed', 'unset "$v"'],
]

describe('gate: scripts it can’t see and text arithmetic re-reads', () => {
  it.each(hidden)('asks about %s', line => {
    expect(outcome(commandFindings(line, context))).not.toBe('allowed')
  })

  it.each(lines)('%s: %s', (expected, line) => {
    expect(outcome(commandFindings(line, context))).toBe(expected)
  })

  // Against the bash the gate's commands would run on: macOS's 3.2 on a Mac, a current one on Linux.
  it.effect(
    'whatever pushes on the real bash isn’t allowed',
    () =>
      Effect.gen(function* () {
        const base = yield* tempFolder('gate-unseen')
        const bin = join(base, 'bin')
        mkdirSync(bin)
        writeFileSync(
          join(bin, 'git'),
          '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MARK"\n',
          { mode: 0o755 },
        )
        const pushes = (line: string): boolean => {
          const folder = mkdtempSync(join(base, 'run-'))
          const mark = join(folder, '.mark')
          spawnSync('/bin/bash', ['-c', line], {
            cwd: folder,
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              MARK: mark,
              HOME: folder,
            },
            stdio: 'ignore',
            timeout: 5_000,
          })
          return existsSync(mark)
        }
        // The stub is on the PATH, and the forms this ticket is about push on this bash.
        expect(pushes(push)).toBe(true)
        expect(pushes(`${held}echo $((x))`)).toBe(true)
        expect(pushes(`bash /dev/stdin <<< '${push}'`)).toBe(true)
        expect(pushes('ls')).toBe(false)
        // A login shell's profile would put the real git ahead of the stub.
        expect(
          [...hidden, ...onSomeBash].filter(line =>
            /\s-\w*l\b|--login/u.test(line),
          ),
        ).toEqual([])
        const looser = [...hidden, ...onSomeBash].filter(
          line =>
            pushes(line) &&
            outcome(commandFindings(line, context)) === 'allowed',
        )
        expect(looser).toEqual([])
      }).pipe(Effect.scoped),
    60_000,
  )
})
