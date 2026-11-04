import { Effect, Option } from 'effect'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { tempFolder } from '@fabrica/testkit'

import { type Finding, commandFindings } from '../src/gate/commands'
import { analyze } from '../src/gate/policy'

// Path confinement through links (spec §12.6, §20.2, H62): files in a worktree are hostile, so a path
// is read as the file system resolves it. A temp folder holds the worktree and a folder outside it:
//
//   base/worktree/src/a.ts            base/outside/file
//   base/worktree/out -> base/outside
//   base/worktree/dangling -> base/outside/new
//   base/worktree/file -> base/outside/file
//   base/worktree/deep -> worktree/src/deep/er
//   base/worktree/inner -> src
//   base/worktree/loop -> loop
//   base/worktree/nest/out -> base/outside
//   base/worktree/.hidden -> base/outside

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

/** A worktree and a folder outside it, with the links above; where they are. */
const scene = Effect.gen(function* () {
  const base = yield* tempFolder('gate-links')
  const worktree = join(base, 'worktree')
  const outside = join(base, 'outside')
  mkdirSync(join(worktree, 'src/deep/er'), { recursive: true })
  mkdirSync(join(worktree, 'nest'))
  mkdirSync(outside)
  writeFileSync(join(outside, 'file'), 'outside')
  writeFileSync(join(worktree, 'src/a.ts'), 'inside')
  symlinkSync(outside, join(worktree, 'out'))
  symlinkSync(join(outside, 'new'), join(worktree, 'dangling'))
  symlinkSync(join(outside, 'file'), join(worktree, 'file'))
  symlinkSync(join(worktree, 'src/deep/er'), join(worktree, 'deep'))
  symlinkSync('src', join(worktree, 'inner'))
  symlinkSync('loop', join(worktree, 'loop'))
  symlinkSync(outside, join(worktree, 'nest/out'))
  symlinkSync(outside, join(worktree, '.hidden'))
  return { base, worktree, outside }
})

const commands: ReadonlyArray<readonly [Expected, string]> = [
  // Through a link out of the worktree: a write is asked, a removal refused.
  ['asked', 'echo x > out/new'],
  ['asked', 'touch out/new'],
  ['asked', 'mkdir -p out/a/b'],
  ['asked', 'cp src/a.ts out/'],
  ['asked', 'mv src/a.ts out/a.ts'],
  ['refused', 'rm out/file'],
  ['refused', 'rm -rf out/a/b'],
  ['refused', 'rm -rf out/*'],
  ['refused', 'mv out/file here'],
  ['refused', 'find out/ -delete'],
  // `find`'s options before its roots: `-H` and `-L` go through a root, `-L` through what it walks.
  ['refused', 'find -H out -delete'],
  ['refused', 'find -L out -delete'],
  ['refused', 'find -P out -delete'],
  ['refused', 'find -L out -exec rm {} +'],
  ['refused', 'find -H -O2 out -delete'],
  ['refused', 'find -f out -delete'],
  ['asked', 'find -L . -type f -exec rm {} +'],
  ['asked', 'find . -follow -delete'],
  ['refused', 'find -H -- out -delete'],
  ['refused', 'find -- out/ -delete'],
  ['refused', 'find -- out -exec rm {} +'],
  ['refused', 'find -fout -delete'],
  ['asked', 'find -follow -delete'],
  ['allowed', 'find -- src -delete'],
  ['allowed', 'find -false -delete'],
  ['allowed', 'find -L . -name x'],
  ['allowed', 'find -H . -delete'],
  ['allowed', 'find src -type f -exec rm {} +'],
  // `{}` stands for anything below the root, a link among it, which the command follows or doesn't.
  ['asked', 'find . -type l -exec chmod 777 {} +'],
  ['refused', 'find . -type l -exec shred {} +'],
  ['asked', 'find . -name file -exec tee {} \\;'],
  ['asked', 'find . -name file -exec cp src/a.ts {} \\;'],
  ['asked', "find . -name file -exec tee '{}' \\;"],
  ['refused', 'find . -name out -exec rm -rf {}/file \\;'],
  ['refused', 'find /nowhere -exec rm -rf {}/x \\;'],
  ['asked', "find . -type l -exec bash -c 'chmod 777 {}' \\;"],
  ['allowed', 'find . -type l -exec rm {} +'],
  ['allowed', 'find src -type f -exec chmod 600 {} +'],
  ['allowed', "find src -name '*.ts' -exec sed -i s/a/b/ {} +"],
  ['allowed', 'find . -name a.ts -exec cat {} +'],
  // So do `chmod -L` and its like, as they walk.
  ['asked', 'chmod -RL 700 .'],
  ['asked', 'chown -RL me .'],
  ['asked', 'chflags -RL nodump .'],
  ['allowed', 'chmod -R 700 src'],
  // A link at the end of a write is followed, a dangling one too: the write creates its target.
  ['asked', 'echo x > file'],
  ['asked', 'echo x > dangling'],
  ['asked', 'tee dangling'],
  // A removal takes the link itself, unless a slash goes through it or it overwrites the target.
  ['allowed', 'rm out'],
  ['allowed', 'rm -rf out dangling'],
  ['allowed', 'unlink out'],
  ['allowed', 'mv out renamed'],
  ['refused', 'rm -rf out/'],
  ['refused', 'rm -rf out/.'],
  ['refused', 'shred file'],
  // `..` after a link is the target's parent, as the system reads it.
  ['refused', 'rm -rf out/../x'],
  ['asked', 'echo x > out/../x'],
  // `cd` takes `..` off first, so a link deeper than where it sits can hide a way out.
  ['asked', 'cd deep/../..; ls'],
  ['refused', 'cd deep/../..; rm -rf x'],
  // A `cd` into a link moves commands out of the worktree.
  ['asked', 'cd out; ls'],
  ['refused', 'cd out && rm -rf x'],
  ['asked', 'cd out && echo x > y'],
  ['asked', 'git -C out status'],
  ['refused', 'cd nest/out; rm -rf ../x'],
  // A wildcard stands for what its folder holds, a link among it.
  ['refused', 'rm -rf */file'],
  ['refused', 'rm -rf */*/file'],
  ['refused', 'rm -rf .*/file'],
  ['refused', 'rm -rf nest/*/'],
  ['asked', 'echo x > */new'],
  ['asked', 'touch o*/new'],
  ['refused', 'rm -rf O*/file'],
  ['refused', 'rm -rf ?ut/file'],
  ['refused', 'rm -rf [o]ut/file'],
  // One that can't match the link is no way through it.
  ['allowed', 'rm -rf s*/x'],
  ['allowed', 'rm -rf build*/x'],
  ['allowed', 'rm -rf *rc/x'],
  ['allowed', 'echo x > s*/new'],
  ['allowed', 'rm -rf o\\*/x'],
  // An extended glob, whose parentheses need no other wildcard, is no subshell: the gate can't read it.
  ['asked', 'shopt -s extglob\nrm -f @(out)/file'],
  ['asked', 'shopt -s extglob\nrm -f !(src)/file'],
  ['asked', 'rm -f @(out)'],
  ['asked', 'echo x > @(out)/new'],
  ['asked', '>@(out) ls'],
  ['asked', "zsh -c 'rm -rf (out)/file'"],
  ['asked', "zsh -c 'chmod 777 (file)'"],
  ['asked', "zsh -c 'rm -rf (*/)#file'"],
  ['asked', 'rm -rf @(/nowhere)/x'],
  ['refused', "zsh -c 'setopt extendedglob; rm -rf ^src/file'"],
  // Subshells, functions and arrays stay what they are.
  ['allowed', '(cd src); ls'],
  ['allowed', '(ls)&&ls'],
  ['allowed', 'time (ls)'],
  ['allowed', 'if (ls); then ls; fi'],
  ['allowed', '! (ls)'],
  ['refused', 'time (rm -rf out/file)'],
  ['allowed', 'f() { ls; }; f'],
  ['allowed', 'a=(x y); ls'],
  ['allowed', 'echo $(ls) x'],
  ['refused', '(rm -rf out/file)'],
  // Characters only an extended glob reads leave a plain name alone.
  ['allowed', 'rm .#lock'],
  ['allowed', 'rm notes~ a#b'],
  ['allowed', "rm -rf 'out(1)/x' 'a#b/x'"],
  // `**` under `globstar` or zsh reaches a link at any depth.
  ['refused', 'rm -rf **/out/file'],
  ['refused', 'rm -rf nest/**/file'],
  ['refused', "zsh -c 'rm -rf **/out/file'"],
  ['allowed', 'rm -rf src/**/x'],
  // At the end of a removal, it takes what it matches, links as links.
  ['allowed', 'rm -rf *'],
  ['allowed', 'rm -rf nest/*'],
  // A link kept inside the worktree stays inside.
  ['allowed', 'echo x > inner/new'],
  ['allowed', 'rm -rf inner/a.ts'],
  ['allowed', 'cd inner && rm -rf a.ts'],
  ['allowed', 'rm -rf deep/x'],
  // A link the gate can't follow to its end, or a path it can't read, asks.
  ['asked', 'echo x > loop'],
  ['asked', 'rm -rf loop/x'],
  ['allowed', 'rm loop'],
  // A link made on this line isn't on disk to read through, so one out of the worktree asks.
  ['asked', 'ln -s /etc x; rm -rf x/y'],
  ['asked', 'ln -sfn .. x'],
  ['asked', 'ln --symbolic -t src /etc'],
  ['asked', 'ln -s "$v" x'],
  ['allowed', 'ln -s src/a.ts x'],
  // A link's target is read from the folder the link is made in.
  ['allowed', 'ln -s ../a.ts src/deep/l'],
  ['allowed', 'ln -s ../a.ts nest/l'],
  ['allowed', 'ln -s ../a.ts -t nest'],
  ['asked', 'ln -s ../../x nest/l'],
  ['asked', 'ln -s /nowhere nest/l'],
  ['asked', 'cd src; ln -s ../../x l'],
  ['allowed', 'ln src/a.ts x'],
]

describe('path confinement through links', () => {
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

  it.effect('names where a path through a link lands', () =>
    Effect.gen(function* () {
      const { worktree, outside } = yield* scene
      const context = { worktree, home: Option.none<string>() }
      expect(reasons(commandFindings('rm out/x', context))).toBe(
        `removes outside the worktree: ${join(outside, 'x')}`,
      )
      expect(reasons(commandFindings('touch out/x', context))).toBe(
        `writes outside the worktree: ${join(outside, 'x')}`,
      )
    }),
  )

  it.effect('reads a tool’s write through a link, as Pi resolves it', () =>
    Effect.gen(function* () {
      const { worktree, outside } = yield* scene
      const context = { worktree, home: Option.none<string>() }
      const written = (path: string) =>
        analyze('write', { path, content: 'x' }, context).findings
      expect(reasons(written('out/new'))).toBe(
        `writes outside the worktree: ${join(outside, 'new')}`,
      )
      expect(outcome(written(join(worktree, 'out/new')))).toBe('asked')
      expect(outcome(written('dangling'))).toBe('asked')
      expect(outcome(written('file'))).toBe('asked')
      expect(outcome(written('src/a.ts'))).toBe('allowed')
      expect(outcome(written('inner/a.ts'))).toBe('allowed')
      // Pi takes `..` off the path before it opens it, so `deep` is no way back in.
      expect(outcome(written('deep/../../x'))).toBe('asked')
      expect(
        outcome(analyze('edit', { path: 'out/file' }, context).findings),
      ).toBe('asked')
    }),
  )

  it.effect('reads a tool’s path as the plain text Pi opens', () =>
    Effect.gen(function* () {
      const { worktree, outside } = yield* scene
      const context = { worktree, home: Option.none<string>() }
      const written = (path: string) =>
        analyze('write', { path, content: 'x' }, context).findings
      for (const name of [
        '(c)',
        'g#',
        '^h',
        '{a,b}',
        'q\\z',
        'a*',
        'b[c]',
        'd?',
        'e,f',
        'my out',
      ]) {
        symlinkSync(outside, join(worktree, name))
        expect(outcome(written(`${name}/x`)), name).toBe('asked')
      }
      // Pi reads these spaces as a plain one.
      expect(outcome(written('my\u00A0out/x'))).toBe('asked')
      expect(outcome(written('my\u3000out/x'))).toBe('asked')
      expect(outcome(written('@my out/x'))).toBe('asked')
      expect(outcome(written('src/{a,b}.ts'))).toBe('allowed')
      // A pattern a shell would read is still read as one.
      expect(outcome(written('src/{a.ts'))).toBe('refused')
    }),
  )

  it.effect('compares with the worktree’s real path, however it is named', () =>
    Effect.gen(function* () {
      const { base, worktree, outside } = yield* scene
      const named = join(base, 'named')
      symlinkSync(worktree, named)
      const context = { worktree: named, home: Option.none<string>() }
      expect(outcome(commandFindings('rm -rf src/a.ts', context))).toBe(
        'allowed',
      )
      expect(
        outcome(commandFindings(`rm -rf ${join(worktree, 'x')}`, context)),
      ).toBe('allowed')
      expect(
        outcome(commandFindings(`rm -rf ${join(named, 'x')}`, context)),
      ).toBe('allowed')
      expect(outcome(commandFindings('rm -rf out/x', context))).toBe('refused')
      expect(outcome(commandFindings('rm -rf ../x', context))).toBe('refused')
      expect(
        outcome(analyze('write', { path: 'src/n.ts' }, context).findings),
      ).toBe('allowed')
      expect(
        outcome(
          analyze('write', { path: join(outside, 'n') }, context).findings,
        ),
      ).toBe('asked')
    }),
  )

  it.effect('reads a home folder held behind a link', () =>
    Effect.gen(function* () {
      const { worktree, base } = yield* scene
      const linked = join(base, 'home')
      symlinkSync(worktree, linked)
      const context = { worktree, home: Option.some(linked) }
      expect(outcome(commandFindings('rm -rf ~/x', context))).toBe('allowed')
      expect(outcome(commandFindings('rm -rf ~/out/x', context))).toBe(
        'refused',
      )
    }),
  )

  it.effect('stops reading a wildcard that reaches too much', () =>
    Effect.gen(function* () {
      const { worktree } = yield* scene
      const crowd = join(worktree, 'crowd')
      mkdirSync(crowd)
      for (let index = 0; index < 4200; index++)
        writeFileSync(join(crowd, `${index}`), '')
      for (const command of ['rm -rf crowd/*/x', 'rm -rf crowd/**/x']) {
        const findings = commandFindings(command, {
          worktree,
          home: Option.none(),
        })
        expect(outcome(findings), command).toBe('asked')
        expect(reasons(findings)).toContain(
          'reaches more than the gate follows',
        )
      }
    }),
  )

  it('reads what doesn’t exist as written', () => {
    const context = { worktree: '/work/fa-1', home: Option.none<string>() }
    expect(outcome(commandFindings('rm -rf a/b/../c', context))).toBe('allowed')
    expect(outcome(commandFindings('rm -rf a/../../c', context))).toBe(
      'refused',
    )
    expect(outcome(commandFindings('rm -rf /nowhere/x', context))).toBe(
      'refused',
    )
  })
})
