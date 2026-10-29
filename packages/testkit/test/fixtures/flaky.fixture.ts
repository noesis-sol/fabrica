import { describe, expect, test } from 'vitest'

import { firstTime } from './marks'

// A deliberately flaky test: it fails the first time it runs and passes on its rerun. Its names hold
// characters a name pattern must escape.
describe('a suite (with parens)', () => {
  test('fails once [then passes]', () => {
    expect(firstTime('flaky')).toBe(false)
  })

  test('passes every time', () => {
    expect(1 + 1).toBe(2)
  })
})
