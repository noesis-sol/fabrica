import { expect, test } from 'vitest'

import { firstTime } from './marks'

// A file whose tests pass, but which throws between them the first time it runs.
test('passes, leaving an error behind once', async () => {
  if (firstTime('stray'))
    await new Promise<void>(resolve => {
      setImmediate(() => {
        resolve()
        throw new Error('a stray error')
      })
    })
  expect(1 + 1).toBe(2)
})
