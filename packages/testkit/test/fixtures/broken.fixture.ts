import { expect, test } from 'vitest'

// A test that fails every time it runs.
test('fails every time', () => {
  expect(1 + 1).toBe(3)
})

test('passes beside it', () => {
  expect(1 + 1).toBe(2)
})
