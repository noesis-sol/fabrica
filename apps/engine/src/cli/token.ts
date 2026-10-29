import { Data, DateTime, Effect, Option, Redacted, Schema } from 'effect'
import { Argument, Command } from 'effect/cli'

import { CreatedToken, TokenInfo, TokenName } from '@fabrica/contracts'

import { withEngine } from './connect'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica token create|list|revoke` (spec §19, §9.3): pairing tokens for clients reaching the engine
// over TLS. `create` prints the token once, as the engine makes it: the engine keeps only its hash.
// Tokens are listed and revoked by name; a revoked token is refused, and its connections closed.

/** The engine refused what the command asked: the name is taken, or names no token. */
export class TokenRefused extends Data.TaggedError('TokenRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The token a command acts on, by its name. */
const nameArgument = Argument.String('name').pipe(
  Argument.withDescription("The token's name, one word"),
  Argument.withSchema(TokenName),
)

const createdText = (created: CreatedToken): string =>
  [
    `token ${sanitiseLine(created.name)}:`,
    sanitiseLine(Redacted.value(created.token)),
    'it is shown only now: the engine keeps only its hash',
  ].join('\n')

const create = Command.make('create', { name: nameArgument }, ({ name }) =>
  withEngine(client => client.rpc['tokens.create']({ name })).pipe(
    Effect.catchTag('TokenExists', () =>
      Effect.fail(
        new TokenRefused({
          reason: `a token named ${sanitiseLine(name)} exists already: revoke it, or name this one otherwise`,
        }),
      ),
    ),
    Effect.flatMap(value =>
      printAnswer({ schema: CreatedToken, value, text: createdText }),
    ),
  ),
).pipe(
  Command.withDescription(
    'Makes a pairing token and prints it, only this once',
  ),
)

const listText = (tokens: ReadonlyArray<TokenInfo>): string => {
  if (tokens.length === 0)
    return 'no pairing tokens: make one with `fabrica token create <name>`'
  const names = tokens.map(token => sanitiseLine(token.name))
  const width = Math.max(...names.map(name => name.length))
  return tokens
    .map(
      (token, index) =>
        `${(names[index] ?? '').padEnd(width)}  made ${DateTime.formatIso(token.createdAt)}  ${Option.match(
          token.lastUsedAt,
          {
            onNone: () => 'never used',
            onSome: at => `last used ${DateTime.formatIso(at)}`,
          },
        )}`,
    )
    .join('\n')
}

const list = Command.make('list', {}, () =>
  withEngine(client => client.rpc['tokens.list']()).pipe(
    Effect.flatMap(value =>
      printAnswer({ schema: Schema.Array(TokenInfo), value, text: listText }),
    ),
  ),
).pipe(Command.withDescription('The pairing tokens, by name'))

/** `fabrica token revoke`'s answer. */
const RevokedAnswer = Schema.Struct({ revoked: TokenName })

const revoke = Command.make('revoke', { name: nameArgument }, ({ name }) =>
  withEngine(client => client.rpc['tokens.revoke']({ name })).pipe(
    Effect.catchTag('TokenNotFound', () =>
      Effect.fail(
        new TokenRefused({
          reason: `the engine has no token named ${sanitiseLine(name)}`,
        }),
      ),
    ),
    Effect.andThen(
      printAnswer({
        schema: RevokedAnswer,
        value: { revoked: name },
        text: ({ revoked }) =>
          `revoked ${sanitiseLine(revoked)}: the engine refuses it from now on, and has closed its connections`,
      }),
    ),
  ),
).pipe(Command.withDescription('Revokes a pairing token'))

export const token = Command.make('token').pipe(
  Command.withDescription('Pairing tokens'),
  Command.withSubcommands([create, list, revoke]),
)
