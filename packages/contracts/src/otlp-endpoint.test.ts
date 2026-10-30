import { Effect, Exit, Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { decodeEngineSettings, decodeProjectSettings } from './index'

// Telemetry's OTLP export (spec §21): off by default, on where the engine's `telemetry.otlp_endpoint`
// names an OTLP/HTTP endpoint; never a project's setting.

describe('telemetry.otlp_endpoint', () => {
  it.effect('is off by default', () =>
    Effect.gen(function* () {
      const settings = yield* decodeEngineSettings({})
      expect(settings.telemetry.otlp_endpoint).toStrictEqual(Option.none())
    }),
  )

  it.effect.each([
    'http://localhost:4318',
    'https://otel.example.com/',
    'http://[::1]:4318/collector',
  ])('reads %s', endpoint =>
    Effect.gen(function* () {
      const settings = yield* decodeEngineSettings({
        telemetry: { otlp_endpoint: endpoint },
      })
      expect(settings.telemetry.otlp_endpoint).toStrictEqual(
        Option.some(endpoint),
      )
    }),
  )

  it.effect.each([
    'localhost:4318',
    'grpc://localhost:4317',
    'http://',
    'http://host/?token=x',
    '',
  ])('refuses %j', endpoint =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeEngineSettings({ telemetry: { otlp_endpoint: endpoint } }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect('is the engine’s, never a project’s', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeProjectSettings({
          telemetry: { otlp_endpoint: 'http://localhost:4318' },
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
