import { describe, expect, it } from '@effect/vitest'

import packageJson from '../package.json' with { type: 'json' }
import { version, versionLine } from './version'

describe('version', () => {
  it('is the package version', () => {
    expect(version).toBe(packageJson.version)
  })

  it('names the program in the version line', () => {
    expect(versionLine).toBe(`fabrica ${packageJson.version}`)
  })
})
