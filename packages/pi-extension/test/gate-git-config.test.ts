import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { type Finding, commandFindings } from '../src/gate/commands'

// git config's writes (spec §12.6, §20.2): in a linked worktree a plain write lands in
// $GIT_COMMON_DIR/config, outside the worktree and shared by every worker and the main checkout,
// where core.fsmonitor or core.hooksPath runs commands inside the engine's own git. Only a write
// with --worktree, or to a file inside the worktree, stays in it.

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
  // Writes to the shared config, the user's or the system's.
  ['asked', 'git config core.hooksPath /tmp/h'],
  ['asked', "git config core.fsmonitor 'touch /tmp/x'"],
  ['asked', 'git config alias.p push'],
  ['asked', 'git config remote.origin.url https://example.com/x.git'],
  ['asked', 'git config user.email a@example.com'],
  ['asked', 'git config --local core.hooksPath /tmp/h'],
  ['asked', 'git config --global user.name x'],
  ['asked', 'git config --system core.editor vi'],
  ['asked', 'git config --type bool core.bare true'],
  ['asked', 'git config --add remote.origin.fetch +refs/x:refs/x'],
  ['asked', 'git config --replace-all core.hooksPath /tmp/h'],
  ['asked', 'git config --unset core.fsmonitor'],
  ['asked', 'git config --unset-all core.fsmonitor'],
  ['asked', 'git config --rename-section core x'],
  ['asked', 'git config --remove-section core'],
  ['asked', 'git config -e'],
  ['asked', 'git config --edit'],
  ['asked', 'git config set core.hooksPath /tmp/h'],
  ['asked', 'git config set --local core.hooksPath /tmp/h'],
  ['asked', 'git config unset core.fsmonitor'],
  ['asked', 'git config edit'],
  ['asked', 'git config rename-section core x'],
  ['asked', 'git config remove-section core'],
  ['asked', 'git -C sub config core.hooksPath /tmp/h'],
  // A form the gate can't read is taken as a write.
  ['asked', 'git config "$key" "$value"'],
  ['asked', 'git config $args'],
  // Writes that stay in the worktree.
  ['allowed', 'git config --worktree core.hooksPath .hooks'],
  ['allowed', 'git config set --worktree user.email a@example.com'],
  ['allowed', 'git config --worktree --unset core.fsmonitor'],
  ['allowed', 'git config -f .gitmodules submodule.x.url ../x'],
  ['allowed', 'git config --file=notes.cfg a.b c'],
  ['asked', 'git config -f /tmp/cfg a.b c'],
  // Reads.
  ['allowed', 'git config core.hooksPath'],
  ['allowed', 'git config --get core.hooksPath'],
  ['allowed', 'git config --get-all remote.origin.fetch'],
  ['allowed', 'git config --get-regexp ^alias'],
  ['allowed', 'git config --get-urlmatch http https://example.com'],
  ['allowed', 'git config --global --get user.email'],
  ['allowed', 'git config -l'],
  ['allowed', 'git config --list --show-origin'],
  ['allowed', 'git config --type bool core.bare'],
  ['allowed', 'git config get user.email'],
  ['allowed', 'git config get --global user.email'],
  ['allowed', 'git config list'],
  ['allowed', 'git config -f /tmp/cfg --get a.b'],
  ['allowed', 'git config'],
]

describe("git config's writes", () => {
  for (const [expected, command] of table)
    it(`${expected}: ${command}`, () => {
      expect(
        outcome(
          commandFindings(command, {
            worktree,
            home: Option.some('/home/agent'),
            cdPath: false,
            cdableVariables: false,
          }),
        ),
      ).toBe(expected)
    })
})
