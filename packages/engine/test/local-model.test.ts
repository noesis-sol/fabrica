import { Effect, Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { RunId } from '@fabrica/contracts'

import { modelsJson } from '../src/agent/launch'
import { Authentication, layerOpen, make } from '../src/proxy'
import { SecretName, Secrets } from '../src/secrets'
import { testSecrets } from './scripted-run'

// What Pi is told of a local model (spec §12.5, §12.9): Pi's catalog has no Ollama or LM Studio, so it
// refuses `--provider ollama` ("Unknown provider") unless `models.json` gives the provider's API and its
// model. The real Pi takes it in packages/pi-extension/test/contract-local-model.test.ts.

const local = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:9/ollama',
  localApi: 'openai-completions',
}
const hosted = {
  provider: 'anthropic',
  baseUrl: 'http://127.0.0.1:9/anthropic',
}

const written = (model: Parameters<typeof modelsJson>[0]['model']): unknown =>
  JSON.parse(modelsJson({ providers: [local, hosted], token: 't', model }))

describe('the model proxy’s grant', () => {
  it.effect(
    'gives a local model’s entry its API, and a hosted provider’s none',
    () =>
      Effect.gen(function* () {
        const proxy = yield* make({
          routes: [
            {
              provider: 'ollama',
              upstream: 'http://127.0.0.1:9/v1',
              api: 'openai-completions',
              authentication: Authentication.None(),
            },
            {
              provider: 'anthropic',
              upstream: 'http://127.0.0.1:9',
              api: 'anthropic-messages',
              authentication: Authentication.Header({
                header: 'x-api-key',
                credential: SecretName.make('anthropic'),
              }),
            },
          ],
        }).pipe(
          Effect.provideService(Secrets, testSecrets),
          Effect.provide(layerOpen),
        )
        const agent = yield* proxy.grant({
          run: RunId.make('run-1'),
          ticket: Option.none(),
          session: Option.none(),
          model: 'stub',
        })
        expect(agent.providers).toStrictEqual([
          {
            provider: 'ollama',
            baseUrl: `${proxy.address}/ollama`,
            localApi: 'openai-completions',
          },
          { provider: 'anthropic', baseUrl: `${proxy.address}/anthropic` },
        ])
      }).pipe(Effect.scoped),
  )
})

describe('models.json for a local model', () => {
  it.effect('names the agent’s model on its local provider, with its API', () =>
    Effect.sync(() => {
      expect(
        written(Option.some({ provider: 'ollama', modelId: 'qwen2.5:7b' })),
      ).toStrictEqual({
        providers: {
          ollama: {
            baseUrl: local.baseUrl,
            apiKey: 't',
            api: 'openai-completions',
            models: [{ id: 'qwen2.5:7b' }],
          },
          anthropic: { baseUrl: hosted.baseUrl, apiKey: 't' },
        },
      })
    }),
  )

  it.effect('adds nothing to a provider the agent’s model isn’t on', () =>
    Effect.sync(() => {
      const unchanged = {
        providers: {
          ollama: { baseUrl: local.baseUrl, apiKey: 't' },
          anthropic: { baseUrl: hosted.baseUrl, apiKey: 't' },
        },
      }
      expect(
        written(Option.some({ provider: 'anthropic', modelId: 'claude-x' })),
      ).toStrictEqual(unchanged)
      expect(written(Option.none())).toStrictEqual(unchanged)
    }),
  )
})
