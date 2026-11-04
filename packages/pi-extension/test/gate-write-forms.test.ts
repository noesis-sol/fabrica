import { Effect, Option } from 'effect'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { tempFolder } from '@fabrica/testkit'

import { type Finding, commandFindings } from '../src/gate/commands'
import { analyze } from '../src/gate/policy'

// The forms of a write the gate reads (spec §12.6, §20.2), in a temp folder holding the worktree:
//
//   base/worktree/a.ts
//   base/worktree/src/a.ts
//   base/worktree/src/deep/up -> base/worktree
//   base/worktree/out -> base/outside

type Expected = 'allowed' | 'asked' | 'refused'

/** What the gate's `workspace` level makes of `findings`. */
const outcome = (findings: ReadonlyArray<Finding>): Expected =>
  findings.some(({ _tag }) => _tag === 'Refused' || _tag === 'Push')
    ? 'refused'
    : findings.some(({ _tag }) => _tag === 'Ask')
      ? 'asked'
      : 'allowed'

const reasons = (findings: ReadonlyArray<Finding>): string =>
  findings
    .map(finding => ('reason' in finding ? finding.reason : finding._tag))
    .join('; ')

const scene = Effect.gen(function* () {
  const base = yield* tempFolder('gate-write-forms')
  const worktree = join(base, 'worktree')
  const outside = join(base, 'outside')
  mkdirSync(join(worktree, 'src/deep'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(worktree, 'a.ts'), 'inside')
  writeFileSync(join(worktree, 'src/a.ts'), 'inside')
  symlinkSync(worktree, join(worktree, 'src/deep/up'))
  symlinkSync(outside, join(worktree, 'out'))
  return { worktree }
})

const commands: ReadonlyArray<readonly [Expected, string]> = [
  // `sed`'s in-place option with its suffix attached, in a group, and BSD's.
  ['asked', 'sed -i.bak s/a/b/ /tmp/x'],
  ['asked', 'sed -ibak s/a/b/ /tmp/x'],
  ['asked', 'sed -ni.bak s/a/b/ /tmp/x'],
  ['asked', 'sed -Ei.bak s/a/b/ src/a.ts /tmp/x'],
  ['asked', 'sed --in-place=.bak s/a/b/ /tmp/x'],
  ['asked', 'sed -I .bak s/a/b/ /tmp/x'],
  ['asked', 'sed -i.bak s/a/b/ out/x'],
  ['asked', 'sed -if s/a/b/ /tmp/x'],
  ['asked', "sed -i '' s/a/b/ /tmp/x"],
  // Its script attached leaves every operand a file.
  ['asked', 'sed -i -es/a/b/ /tmp/x'],
  ['asked', 'sed -i.bak -es/a/b/ /tmp/x'],
  ['asked', 'sed -i -ne s/a/b/ /tmp/x'],
  ['asked', 'sed -i -fscript /tmp/x'],
  ['asked', 'sed -i --expression=s/a/b/ /tmp/x'],
  ['allowed', 'sed -i.bak s/a/b/ src/a.ts'],
  ['allowed', 'sed -i.bak -e s/a/b/ src/a.ts'],
  ['allowed', 'sed -i.bak -es/a/b/ src/a.ts'],
  ['allowed', 'sed -n s/a/b/p /tmp/x'],
  ['allowed', 'sed -e s/a/b/ /tmp/x'],
  ['allowed', 'sed -ei /tmp/x'],
  ['asked', 'sed -bi s/a/b/ /tmp/x'],
  ['asked', 'sed -li s/a/b/ /tmp/x'],
  ['asked', 'sed -li.bak s/a/b/ /tmp/x'],
  ['asked', 'sed -nlI.bak s/a/b/ /tmp/x'],
  // A value or an operand opening `-i` is no option, and leaves the next word to be read.
  ['asked', 'sed -i -f -i /tmp/x'],
  ['asked', 'sed -i --file -i /tmp/x'],
  ['asked', 'sed -i s/a/b/ -- -i/../../x'],
  ['asked', 'sed -i.bak -- s/a/b/ -i/../../x'],
  ['asked', 'sed -i s/a/b/ -- -e"$x"'],
  ['allowed', 'sed -e -i /tmp/x'],
  ['allowed', 'sed -- -i /tmp/x'],
  // A long option shortened, as GNU's parser lets it.
  ['asked', 'sed --in s/a/b/ /tmp/x'],
  ['asked', 'sed --in=.bak s/a/b/ /tmp/x'],
  ['asked', 'sed -i --expr=s/a/b/ /tmp/x'],
  ['asked', 'sed -i --expr s/a/b/ /tmp/x'],
  // A suffix or a script known only when it runs is still one.
  ['asked', 'sed --in-place="$x" s/a/b/ /tmp/x'],
  ['asked', 'sed -i"$x" s/a/b/ /tmp/x'],
  ['allowed', 'sed -i -e"s/$a/b/" src/a.ts'],
  ['allowed', 'sed -i.bak -e"s/$a/b/" src/a.ts'],
  ['allowed', 'sed -i --expression="s/$a/b/" -e s/c/d/ src/a.ts'],
  ['allowed', "sed -i -e$'s/a/\\t/' src/a.ts"],
  ['asked', 'sed -i -e"s/$a/b/" /tmp/x'],
  // `-t`'s value attached or in a group, up to `--`.
  ['asked', 'cp -t/tmp/x src/a.ts'],
  ['asked', 'cp -rt/tmp/x src'],
  ['asked', 'cp -rt /tmp/x src'],
  ['asked', "cp -t'/tmp/x y' src/a.ts"],
  ['asked', 'cp -t"$d" src/a.ts'],
  ['asked', 'cp -- -tsrc /tmp/x'],
  ['asked', 'cp -S -t src/a.ts /tmp/x'],
  ['asked', 'mv -t/tmp/x src/a.ts'],
  ['asked', 'mv -ft/tmp/x src/a.ts'],
  ['asked', 'mv -ft /tmp/x src/a.ts'],
  ['asked', 'mv src/a.ts --target-directory=/tmp/x'],
  ['asked', 'mv --target-directory /tmp/x src/a.ts'],
  ['asked', 'cp --target=/tmp/x a.ts'],
  ['asked', 'cp --target /tmp/x a.ts'],
  ['asked', 'mv --t=/tmp/x a.ts'],
  // The letters of an attached value are no options.
  ['asked', 'install -tout a.ts'],
  ['asked', 'ln -s -Sn ../x src/deep/up'],
  ['asked', 'ln --sym ../x src/deep/up'],
  ['allowed', 'ln -tsrc /tmp/x'],
  // Only the options whose value the gate reads may be shortened: another's next word is still an operand.
  ['asked', 'cp --o src/a.ts /tmp/x'],
  ['asked', 'chmod --ref src/a.ts /tmp/x'],
  ['asked', 'chown --ref src/a.ts /tmp/x'],
  ['asked', 'chgrp --ref src/a.ts /tmp/x'],
  ['asked', 'chmod --ref=src/a.ts /tmp/x'],
  ['asked', 'chmod --refe=src/a.ts /tmp/x'],
  ['asked', 'chmod --reference=src/a.ts /tmp/x'],
  ['allowed', 'git switch --force main'],
  ['allowed', 'install -tsrc /tmp/x'],
  ['asked', 'install -t/tmp/x src/a.ts'],
  ['asked', 'ln -t/tmp/x src/a.ts'],
  ['asked', 'mkdir -pm 755 /tmp/x'],
  ['refused', 'mv -tsrc /tmp/x'],
  ['refused', 'mv -ftsrc /tmp/x'],
  ['allowed', 'cp -tsrc a.ts'],
  ['allowed', 'cp -rtsrc a.ts'],
  ['allowed', 'cp -rt src a.ts'],
  ['allowed', 'mv -tsrc a.ts'],
  ['allowed', 'cp /tmp/x src'],
  ['allowed', 'cp -Rp /tmp/x src'],
  ['allowed', 'mkdir -pm 755 src/new'],
  // `find`'s outputs.
  ['asked', 'find . -fprint /tmp/x'],
  ['asked', 'find . -fprint0 /tmp/x'],
  ['asked', 'find . -fls /tmp/x'],
  ['asked', 'find . -fprintf /tmp/x %p'],
  ['asked', 'find . -name a.ts -fprint out/x'],
  ['asked', 'find -fprint /tmp/x'],
  ['asked', 'find . -fprint "$x"'],
  ['allowed', 'find . -fprint src/x'],
  ['allowed', 'find . -fprintf src/x /tmp/y'],
  ['allowed', 'find /tmp -name x -print'],
  ['allowed', 'find . -exec cat -fprint /tmp/x \\;'],
  // `git init`'s path, and the folder it keeps its repository in.
  ['asked', 'git init /tmp/x'],
  ['asked', 'git init --bare /tmp/x'],
  ['asked', 'git init -q -b main /tmp/x'],
  ['asked', 'git init out/x'],
  ['asked', 'git init --separate-git-dir=/tmp/x'],
  ['asked', 'git init --separate-git-dir /tmp/x src'],
  ['asked', 'git -C src init ../../x'],
  ['allowed', 'git init'],
  ['allowed', 'git init src/new'],
  ['allowed', 'git init -b main src/new'],
  // A template's hooks land where every worktree runs them.
  ['asked', 'git init --template=/tmp/x'],
  ['asked', 'git init --template src/t'],
  ['asked', 'git init --template="$t"'],
  ['asked', 'git -c init.templateDir=src/t init'],
  ['asked', 'GIT_TEMPLATE_DIR=src/t git init'],
  ['asked', 'git --config-env=init.templateDir=T init'],
  ['asked', 'git --config-env init.templateDir=T init'],
  ['asked', 'git --config-env=core.hooksPath=T status'],
  ['asked', 'GIT_CONFIG_COUNT=1 git init'],
  ['asked', 'GIT_CONFIG_PARAMETERS=x git init'],
  ['asked', 'git init --templ=/tmp/x'],
  ['asked', 'git init --sep=/tmp/x'],
  ['asked', 'git init --sep /tmp/x'],
  ['allowed', 'git --config-env=user.name=T status'],
  ['allowed', 'git -C src init new'],
  // `sort`'s output.
  ['asked', 'sort -o /tmp/x a.ts'],
  ['asked', 'sort -o/tmp/x a.ts'],
  ['asked', 'sort -uo /tmp/x a.ts'],
  ['asked', 'sort --output=/tmp/x a.ts'],
  ['asked', 'sort --output /tmp/x a.ts'],
  ['asked', 'sort --out=/tmp/x a.ts'],
  ['asked', 'sort --out /tmp/x a.ts'],
  ['asked', 'sort a.ts -o /tmp/x'],
  ['asked', 'sort -o src/x -o /tmp/x a.ts'],
  ['asked', 'sort -o out/x a.ts'],
  ['allowed', 'sort -o src/x a.ts'],
  ['allowed', 'sort /tmp/x'],
  ['allowed', 'sort -t, -k2 /tmp/x'],
  ['allowed', 'sort -to /tmp/x'],
  ['allowed', 'sort -k 2 -o src/x /tmp/y'],
  ['allowed', 'sort -- -o /tmp/x'],
  // `busybox` and `toybox` run the command their first word names.
  ['refused', 'busybox rm -rf /tmp/x'],
  ['refused', '/bin/busybox rm -rf /tmp/x'],
  ['refused', 'toybox rm -rf /tmp/x'],
  ['refused', "busybox sh -c 'rm -rf /tmp/x'"],
  ['refused', "busybox ash -c 'rm -rf /tmp/x'"],
  ['refused', "ash -c 'rm -rf /tmp/x'"],
  ['asked', 'busybox cp a.ts /tmp/x'],
  ['asked', 'busybox wget example.com'],
  ['asked', 'busybox --install -s /tmp/x'],
  ['asked', 'busybox "$x" /tmp/x'],
  ['allowed', 'busybox'],
  ['allowed', 'busybox --list'],
  ['allowed', 'busybox ls /tmp'],
  ['allowed', 'busybox rm -rf src/new'],
  // A `$"…"` word reads as its `"…"`.
  ['refused', 'rm -rf $"out"/x'],
  ['refused', 'rm -rf $"/tmp/x"'],
  ['refused', '$"rm" -rf /tmp/x'],
  ['asked', 'echo x > $"out/x"'],
  ['asked', 'touch $"$HOME"/x'],
  ['allowed', 'rm -rf $"src/new"'],
  ['allowed', 'echo "a$" > src/new'],
  // A `$'…'` whose escapes stand for themselves reads as what it says.
  ['refused', "rm -rf $'/tmp/x'"],
  ['refused', "rm -rf $'/tmp/\\\\x'"],
  ['allowed', "rm -rf $'src/new'"],
  ['allowed', "rm -rf $'src/it\\'s'"],
  // Common forms that spell only arguments stay as they were.
  ['allowed', "git add -A; git diff --stat $'a\\n'"],
  ['allowed', "git commit -m $'a\\n\\nb'"],
  ['allowed', "grep $'\\t' /tmp/x"],
  ['allowed', "IFS=$'\\n' read -r line"],
  ['allowed', "sed -i $'s/a/\\t/' src/a.ts"],
  // `ln -s` into a folder the last operand already is: the target is read from there.
  ['allowed', 'ln -s ../a.ts src'],
  ['allowed', 'ln -s ../a.ts src/'],
  ['allowed', 'ln -s ../../a.ts src/deep'],
  ['allowed', 'ln -s ../a.ts ../a.ts src'],
  ['asked', 'ln -s ../../x src'],
  ['asked', 'ln -s ../../../x src/deep'],
  ['asked', 'ln -s ../a.ts new'],
  ['asked', 'ln -sT ../a.ts src'],
  ['asked', 'ln -s --no-target-directory ../a.ts src'],
  // A link to a folder is read as that folder, unless `-n` keeps it.
  ['asked', 'ln -s ../x src/deep/up'],
  ['allowed', 'ln -sn ../x src/deep/up'],
  ['asked', 'ln -s ../x "$d"'],
  // A folder the line may replace first is no folder to read from: the link may take its place.
  ['asked', 'rm -rf src; ln -s ../x src; echo y > src/z'],
  ['asked', 'rmdir src; ln -s ../x src'],
  ['asked', 'mv src gone && ln -sf ../x src && touch src/z'],
  ['asked', "bash -c 'rm -rf src; ln -s ../x src'"],
  ['asked', "bash -c 'rm -rf src'; bash -c 'ln -s ../x src'"],
  ['asked', 'find . -exec rm -rf src \\; -exec ln -s ../x src \\;'],
  ['asked', 'ln -sfF ../x src'],
  // GNU's `-r` reads a target from the current folder.
  ['asked', 'ln -sr ../x src'],
  ['asked', 'ln -s -r ../x src'],
  ['asked', 'ln --relative -s ../x src'],
  ['asked', 'ln --rel -s ../x src'],
  ['asked', 'ln -sr ../x src/deep'],
  ['asked', 'ln -sr ../x src/new'],
  ['asked', 'ln -sr -t src ../x'],
  ['allowed', 'ln -sr a.ts src'],
  ['allowed', 'ln -sr src/a.ts src/new'],
  ['asked', 'cd "$d"; ln -s ../a.ts src'],
]

/** Spelled by an escape: the gate doesn't let any such word through as what it isn't. */
const escaped: ReadonlyArray<string> = [
  "rm -rf $'\\x6fut'/x",
  "rm -rf $'o\\165t'/x",
  "$'\\x72m' -rf /tmp/x",
  "echo x > $'\\x6fut'/x",
  "touch $'\\x6fut/x'",
  "bash -c $'rm -rf /tmp/x\\n'",
  // An option or a primary spelled by one.
  "sort $'-\\x6f' /tmp/x a.ts",
  "sort $'\\x2do' /tmp/x a.ts",
  "sed $'-\\x69' s/a/b/ /tmp/x",
  "cp $'-\\x74' /tmp/x a.ts",
  "cp $'-\\x74/tmp/x' a.ts",
  "cp $'-\\u0074/tmp/x' a.ts",
  "find . $'-fprin\\x74' /tmp/x",
  "find /tmp $'-de\\x6cete'",
  "find /tmp $'-de\\154ete'",
]

describe('the gate’s forms of a write', () => {
  for (const [expected, command] of commands)
    it.effect(`${expected}: ${command}`, () =>
      Effect.gen(function* () {
        const { worktree } = yield* scene
        const findings = commandFindings(command, {
          worktree,
          home: Option.none(),
        })
        expect(outcome(findings), reasons(findings)).toBe(expected)
      }),
    )

  for (const command of escaped)
    it.effect(`not allowed: ${command}`, () =>
      Effect.gen(function* () {
        const { worktree } = yield* scene
        const findings = commandFindings(command, {
          worktree,
          home: Option.none(),
        })
        expect(outcome(findings)).not.toBe('allowed')
      }),
    )

  it.effect('reads the rest of a line a character code is on', () =>
    Effect.gen(function* () {
      const { worktree } = yield* scene
      const context = { worktree, home: Option.none<string>() }
      const code = "$'\\x41'"
      for (const command of [
        `rm -rf /tmp/x ${code}`,
        `rm -rf /tmp/x; echo ${code}`,
        `git branch -D other; echo ${code}`,
      ])
        expect(outcome(commandFindings(command, context)), command).toBe(
          'refused',
        )
      for (const command of [
        `git commit -m ${code}`,
        `git reset --hard main; echo ${code}`,
      ]) {
        const findings = commandFindings(command, context)
        expect(
          findings.some(({ _tag }) => _tag === 'BranchWrite'),
          command,
        ).toBe(true)
      }
    }),
  )

  it.effect('asks about a tool’s file URL it can’t read', () =>
    Effect.gen(function* () {
      const { worktree } = yield* scene
      const context = { worktree, home: Option.none<string>() }
      for (const tool of ['write', 'edit'])
        for (const path of [
          'file://host/x',
          '@file://host/x',
          'file:///a%2Fb',
        ]) {
          const { findings } = analyze(tool, { path }, context)
          expect(outcome(findings), path).toBe('asked')
          expect(reasons(findings)).toBe(
            `the gate can’t read the file URL ${path}`,
          )
        }
      expect(
        outcome(
          analyze('write', { path: `file://${worktree}/src/a.ts` }, context)
            .findings,
        ),
      ).toBe('allowed')
      expect(
        outcome(analyze('write', { path: 'file:///tmp/x' }, context).findings),
      ).toBe('asked')
    }),
  )
})
