import { Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { RunFlags } from './runs'

// A run's flags carry the FABRICA_ variables of settings in the starting client's environment
// (spec §13.13); a client from before they were sent leaves them out, and sends none.

describe("a run's flags' environment", () => {
  it('decodes the variables sent, by name', () => {
    expect(
      Schema.decodeUnknownSync(RunFlags)({
        offline: false,
        settings: { concurrent: '3' },
        environment: { FABRICA_CONCURRENT: '1' },
      }),
    ).toStrictEqual({
      limit: Option.none(),
      offline: false,
      settings: { concurrent: '3' },
      environment: { FABRICA_CONCURRENT: '1' },
      preflight: Option.none(),
    })
  })

  it('is none where a client leaves it out', () => {
    expect(
      Schema.decodeUnknownSync(RunFlags)({ offline: false, settings: {} })
        .environment,
    ).toStrictEqual({})
  })
})
