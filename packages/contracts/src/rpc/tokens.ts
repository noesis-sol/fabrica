import { Option, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { Text } from '../ticket'
import { Moment, Name } from './common'

// The Hosts and tokens group (spec §8.1, §9.3): pairing tokens for the TLS listener. A token is shown
// once, as it is made; the engine keeps only its hash. Tokens are listed and revoked by name.

/** The path the TLS listener serves the protocol on, as a WebSocket. */
export const pairingPath = '/rpc'

/** The `Authorization` header a client presents its pairing token in. */
export const bearerAuthorization = (token: string): string => `Bearer ${token}`

/** The token an `Authorization` header presents; none where it presents no bearer token. */
export const bearerToken = (
  header: string | undefined,
): Option.Option<string> =>
  Option.flatMapNullishOr(
    Option.fromUndefinedOr(header),
    value => /^Bearer (\S+)$/u.exec(value)?.[1],
  )

/** A pairing token's name. */
export const TokenName = Name
export type TokenName = typeof TokenName.Type

/** A token as it is made: the only time its secret crosses. */
export class CreatedToken extends Schema.Class<CreatedToken>('CreatedToken')({
  name: TokenName,
  token: Schema.RedactedFromValue(Text),
}) {}

/** A token as it is listed: never its secret. */
export class TokenInfo extends Schema.Class<TokenInfo>('TokenInfo')({
  name: TokenName,
  createdAt: Moment,
  lastUsedAt: Schema.OptionFromNullOr(Moment),
}) {}

export class TokenExists extends Schema.TaggedError<TokenExists>()(
  'TokenExists',
  { name: TokenName },
) {}

export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  'TokenNotFound',
  { name: TokenName },
) {}

export const TokenRpcs = RpcGroup.make(
  Rpc.make('tokens.create', {
    payload: { name: TokenName },
    success: CreatedToken,
    error: TokenExists,
  }),
  Rpc.make('tokens.list', { success: Schema.Array(TokenInfo) }),
  Rpc.make('tokens.revoke', {
    payload: { name: TokenName },
    error: TokenNotFound,
  }),
)
