import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { type Finding, commandFindings } from '../src/gate/commands'

// The folders a command may run in (spec §12.6, §20.2): the gate doesn't know which of a command
// line's commands run, so a `cd` adds its folder to those before it, and a path must stay inside the
// worktree from each.

const worktree = '/work/fa-1'

type Expected = 'allowed' | 'asked' | 'refused'

/** What the gate's `workspace` level makes of `findings`. */
const outcome = (findings: ReadonlyArray<Finding>): Expected =>
  findings.some(({ _tag }) => _tag === 'Refused' || _tag === 'Push')
    ? 'refused'
    : findings.some(({ _tag }) => _tag === 'Ask')
      ? 'asked'
      : 'allowed'

const table: ReadonlyArray<readonly [Expected, string]> = [
  // A `cd` that may not take effect leaves the folder before it.
  ['refused', 'cd nonexistent; rm -rf ../victim'],
  ['refused', '(cd a/b/c/d); rm -rf ../../../../x'],
  ['refused', 'false && cd a/b/c/d; rm -rf ../../../../x'],
  ['refused', 'if false; then cd a/b/c/d; fi; rm -rf ../../../../x'],
  ['refused', 'f() { cd sub; }; rm -rf ../x'],
  ['refused', 'echo $(cd a/b); rm -rf ../../x'],
  ['refused', 'cd sub && rm -rf ../x'],
  // A `cd` target is read as paths are: globs that can match `..` and every brace alternative.
  ['refused', 'cd .?; rm -rf x'],
  ['refused', 'cd .[.]; rm -rf x'],
  ['refused', 'cd {..,x}; rm -rf y'],
  ['refused', "cd '..'; rm -rf x"],
  ['refused', 'cd ~; rm -rf x'],
  // `eval`'s `cd` moves the shell; `bash -c`'s doesn't, but its own commands run from it.
  ['refused', 'eval cd ..; rm -rf x'],
  ['refused', "bash -c 'cd ..; rm -rf x'"],
  ['refused', 'git -C .. rm -rf x; rm -rf ../y'],
  // CDPATH, cdable_vars, `cd -`, `popd` and `-execdir` land where the gate can't tell.
  ['asked', 'CDPATH=.. cd x; rm -rf y'],
  ['asked', 'export CDPATH=..; cd x; rm -rf y'],
  ['asked', "for i in 1 2; do cd x; eval 'CDPATH=..'; done; rm -rf y"],
  ['asked', 'shopt -s cdable_vars; v=..; cd v; rm -rf y'],
  ['asked', 'cd -; rm -rf x'],
  ['asked', 'pushd +1; rm -rf x'],
  ['asked', 'pushd sub; popd; rm -rf x'],
  ['asked', 'find .. -name x -execdir rm -rf y \\;'],
  ['asked', 'find . -name x -okdir rm -rf y \\;'],
  // A folder left stays one the commands after may run in.
  ['asked', 'cd .. && cd fa-1; ls'],
  // Paths inside the worktree from every folder.
  ['allowed', 'cd src && rm -rf build'],
  ['allowed', 'cd src/{a,b} && ls && rm -rf dist'],
  ['allowed', 'CDPATH=.. cd ./x; rm -rf y'],
  ['allowed', 'find . -name x -exec rm -rf {} \\;'],
  ['allowed', 'git -C sub status && rm -rf build'],
  ['refused', 'find /tmp -name x -execdir rm -rf {} \\;'],
]

describe('the folders a command may run in', () => {
  for (const [expected, command] of table)
    it(`${expected}: ${command}`, () => {
      expect(
        outcome(
          commandFindings(command, {
            worktree,
            home: Option.some('/home/agent'),
          }),
        ),
      ).toBe(expected)
    })

  it('stops following folders past the many a chain of brace cds makes', () => {
    const findings = commandFindings(`${'cd {a,b}; '.repeat(30)}rm -rf x`, {
      worktree,
      home: Option.some('/home/agent'),
    })
    expect(outcome(findings)).toBe('asked')
  })

  it('stops following folders past the many a chain of git -C braces makes', () => {
    const findings = commandFindings(`git ${'-C {a,b} '.repeat(30)}status`, {
      worktree,
      home: Option.some('/home/agent'),
    })
    expect(outcome(findings)).toBe('asked')
  })

  it('places a path outside from any brace alternative, whatever the others', () => {
    expect(
      outcome(
        commandFindings('rm -rf {~bob/x,/tmp/x}', {
          worktree,
          home: Option.some('/home/agent'),
        }),
      ),
    ).toBe('refused')
  })
})
