import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  type Scope,
} from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import { createHash } from 'node:crypto'

import {
  CreatedToken,
  TokenExists,
  TokenInfo,
  type TokenName,
  TokenNotFound,
  TokenRpcs,
} from '@fabrica/contracts'

import { drawToken } from '../control/token'

// The Hosts and tokens group (spec §8.1, §9.3, §20.2): pairing tokens for clients reaching the engine
// over TLS. A token is drawn at random and shown once, as it is made; engine.db keeps only its SHA-256
// hash, so a token is found by hashing what a client presents. Tokens are listed and revoked by name; a
// revoked token is refused from then on, and the connections it opened are closed. A token grants
// everything (H8: one person per engine).

export interface PairingTokensShape {
  readonly create: (
    name: TokenName,
  ) => Effect.Effect<CreatedToken, TokenExists | SqlError.SqlError>
  readonly list: Effect.Effect<ReadonlyArray<TokenInfo>, SqlError.SqlError>
  readonly revoke: (
    name: TokenName,
  ) => Effect.Effect<void, TokenNotFound | SqlError.SqlError>
  /** The name of the token `given` is, where it is one; its use is noted. */
  readonly verify: (
    given: string,
  ) => Effect.Effect<Option.Option<TokenName>, SqlError.SqlError>
  /** Each token revoked from now on, by name, until the scope ends: taken before a token is verified. */
  readonly revocations: Effect.Effect<
    PubSub.Subscription<TokenName>,
    never,
    Scope.Scope
  >
}

/** The engine's pairing tokens, in engine.db. */
export class PairingTokens extends Context.Service<
  PairingTokens,
  PairingTokensShape
>()('@fabrica/engine/PairingTokens') {}

/** A token's hash, as engine.db keeps it. */
const hashOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

/** A pairing token: `fabrica_` and 32 random bytes, in hex. */
const drawPairingToken = Effect.map(
  drawToken,
  random => `fabrica_${Redacted.value(random)}`,
)

interface TokenRow {
  readonly name: string
  readonly created_at: number
  readonly last_used_at: number | null
}

/** The pairing tokens on the engine's database. */
export const pairingTokensLayer = Layer.effect(
  PairingTokens,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const revoked = yield* PubSub.unbounded<TokenName>()

    const create = Effect.fn('PairingTokens.create')(function* (
      name: TokenName,
    ) {
      const token = yield* drawPairingToken
      const now = yield* Clock.currentTimeMillis
      const rows = yield* sql<{ readonly name: string }>`
        INSERT INTO tokens (name, hash, created_at) VALUES (${name}, ${hashOf(token)}, ${now})
        ON CONFLICT (name) DO NOTHING RETURNING name`
      if (rows.length === 0) return yield* new TokenExists({ name })
      return new CreatedToken({ name, token: Redacted.make(token) })
    })

    const list = sql<TokenRow>`
      SELECT name, created_at, last_used_at FROM tokens ORDER BY name`.pipe(
      Effect.map(rows =>
        rows.map(
          row =>
            new TokenInfo({
              name: row.name,
              createdAt: DateTime.makeUnsafe(row.created_at),
              lastUsedAt: Option.map(
                Option.fromNullishOr(row.last_used_at),
                at => DateTime.makeUnsafe(at),
              ),
            }),
        ),
      ),
      Effect.withSpan('PairingTokens.list'),
    )

    const revoke = Effect.fn('PairingTokens.revoke')(function* (
      name: TokenName,
    ) {
      const rows = yield* sql<{ readonly name: string }>`
        DELETE FROM tokens WHERE name = ${name} RETURNING name`
      if (rows.length === 0) return yield* new TokenNotFound({ name })
      yield* PubSub.publish(revoked, name)
    })

    const verify = Effect.fn('PairingTokens.verify')(function* (given: string) {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* sql<{ readonly name: string }>`
        UPDATE tokens SET last_used_at = ${now} WHERE hash = ${hashOf(given)} RETURNING name`
      return Option.map(Option.fromUndefinedOr(rows[0]), row => row.name)
    })

    return PairingTokens.of({
      create,
      list,
      revoke,
      verify,
      revocations: PubSub.subscribe(revoked),
    })
  }),
)

/** The Hosts and tokens group's handlers, on the engine's pairing tokens. */
export const tokensHandlers = TokenRpcs.toLayer(
  Effect.gen(function* () {
    const tokens = yield* PairingTokens
    return TokenRpcs.of({
      'tokens.create': ({ name }) =>
        tokens.create(name).pipe(Effect.catchTag('SqlError', Effect.die)),
      'tokens.list': () => Effect.orDie(tokens.list),
      'tokens.revoke': ({ name }) =>
        tokens.revoke(name).pipe(Effect.catchTag('SqlError', Effect.die)),
    })
  }),
)
