import { Data, Effect, Option, Schema } from 'effect'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProviderConfig } from '@earendil-works/pi-coding-agent'

// GitHub Copilot through the model proxy (spec §12.9; decided in fab-mgi.12). Pi takes a provider's
// base URL from `models.json`, but a Copilot OAuth credential carries a base URL of its own, from its
// token, which wins at request time and skips the proxy. The extension registers Copilot's OAuth
// again so that its credential resolves to a key alone, and the configured URL holds: the proxy's,
// which the engine wrote to the agent's `models.json`. The proxy refreshes the real token itself, so
// the agent's placeholder is never refreshed, and an agent never signs in.

/** Pi's name for GitHub Copilot. */
export const CopilotProvider = 'github-copilot'

/** The part of the agent's `models.json` read here: each provider's base URL. */
const ModelsJson = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Record(
      Schema.String,
      Schema.Struct({ baseUrl: Schema.optionalKey(Schema.String) }),
    ),
  }),
)

/** The agent's `models.json` couldn't be read or decoded. */
export class ModelsUnreadable extends Data.TaggedError('ModelsUnreadable')<{
  readonly path: string
  readonly reason: string
}> {
  override get message() {
    return `the agent's models ${this.path} couldn't be read: ${this.reason}`
  }
}

/** The base URL `models.json` in the configuration folder gives Copilot, where it gives one. */
export const copilotBaseUrl = Effect.fn('Copilot.baseUrl')(function* (
  configFolder: string,
) {
  const path = join(configFolder, 'models.json')
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, 'utf8'),
    catch: error =>
      new ModelsUnreadable({
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
  })
  const models = yield* Schema.decodeUnknownEffect(ModelsJson)(text).pipe(
    Effect.mapError(
      error => new ModelsUnreadable({ path, reason: error.message }),
    ),
  )
  return Option.fromUndefinedOr(models.providers[CopilotProvider]?.baseUrl)
})

/** Copilot's provider, its OAuth credential resolving to the agent's placeholder alone. */
export const copilotProvider = (baseUrl: string): ProviderConfig => ({
  baseUrl,
  oauth: {
    name: 'GitHub Copilot',
    isSubscription: true,
    login: () =>
      Promise.reject(
        new Error('an agent never signs in: the engine holds the credentials'),
      ),
    refreshToken: credentials => Promise.resolve(credentials),
    getApiKey: credentials => credentials.access,
  },
})
