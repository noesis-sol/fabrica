import { Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { CommandLine } from './settings'

// A command line (spec §16, §13.7): on one line, without control characters, and not blank.

describe('CommandLine', () => {
  const is = Schema.is(CommandLine)

  it('takes a command on one line', () => {
    expect(is('scripts/check-fast.sh')).toBe(true)
    expect(is('  pnpm test -- --run  ')).toBe(true)
  })

  it.each([
    ['a newline', 'check\nrm -rf ~'],
    ['a carriage return', 'check\r'],
    ['a lone bell', 'check\u0007'],
    ['only a control character', '\u001b'],
    ['a delete', 'check\u007f'],
    ['nothing but spaces', '   '],
    ['nothing', ''],
  ])('refuses one holding %s', (_, command) => {
    expect(is(command)).toBe(false)
  })
})
