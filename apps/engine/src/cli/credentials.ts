import {
  type Cause,
  Console,
  Data,
  Effect,
  Option,
  Queue,
  Redacted,
  Schema,
  type Scope,
  Stdio,
  Stream,
} from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'

import type { EngineClientShape } from '@fabrica/client'
import {
  CredentialInfo,
  CredentialName,
  CredentialValue,
  LoginStep,
  ProviderName,
  SignInProviders,
} from '@fabrica/contracts'

import { withEngine } from './connect'
import { Json } from './flags'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica credentials set|list|remove|login` (spec §19, §20.3): model credentials in the engine's secret
// store. A key is never on the command line: it is typed at a hidden prompt, or read from stdin where
// that isn't a terminal. A sign-in runs in the engine, which may be another host's: this prints what the
// engine says to open or enter, and answers what it asks at the terminal, or from stdin's next line.

/** The engine refused what the command asked, or a sign-in failed. */
export class CredentialsRefused extends Data.TaggedError('CredentialsRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

const refused = (reason: string) => new CredentialsRefused({ reason })

const nameArgument = Argument.String('name').pipe(
  Argument.withDescription("The credential's name: a provider's, or your own"),
  Argument.withSchema(CredentialName),
)

/** Stdin's lines, read only once something asks for one, ended as it ends. */
const stdinLines = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const lines = yield* Queue.make<string, Cause.Done>()
  yield* stdio.stdin.pipe(
    Stream.orDie,
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runIntoQueue(lines),
    Effect.forkScoped,
  )
  return lines
})

/** The key `set` keeps: typed unseen on a terminal; else all of stdin. */
const keyFromUser = (name: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const key = (yield* stdio.stdinIsTerminal)
      ? yield* Prompt.Hidden({ message: `The key for ${name}` }).pipe(
          Effect.map(Redacted.value),
          Effect.catchTag('QuitError', () => Effect.succeed('')),
        )
      : yield* stdio.stdin.pipe(
          Stream.orDie,
          Stream.decodeText(),
          Stream.mkString,
        )
    const trimmed = key.trim()
    return trimmed === ''
      ? yield* refused(`no key was given for ${sanitiseLine(name)}`)
      : Redacted.make(trimmed)
  })

const SetAnswer = Schema.Struct({ set: CredentialName })

const set = Command.make(
  'set',
  {
    name: nameArgument,
    provider: Flag.String('provider').pipe(
      Flag.withDescription('The provider it is for'),
      Flag.withSchema(ProviderName),
      Flag.optional,
    ),
    command: Flag.String('command').pipe(
      Flag.withDescription(
        'A command whose output is the key, run by the engine when the key is needed, in place of a key',
      ),
      Flag.optional,
    ),
  },
  ({ name, provider, command }) =>
    Effect.gen(function* () {
      const value = yield* Option.match(command, {
        onSome: line =>
          Effect.succeed(CredentialValue.cases.command.make({ command: line })),
        onNone: () =>
          Effect.map(keyFromUser(name), key =>
            CredentialValue.cases.key.make({ key }),
          ),
      })
      yield* withEngine(client =>
        client.rpc['credentials.set']({ name, value, provider }),
      ).pipe(
        Effect.catchTag('CredentialStoreFailed', ({ reason }) =>
          Effect.fail(refused(reason)),
        ),
      )
      yield* printAnswer({
        schema: SetAnswer,
        value: { set: name },
        text: ({ set }) =>
          `set ${sanitiseLine(set)}: the engine keeps it in its host's secret store`,
      })
    }),
).pipe(
  Command.withDescription(
    'Sets an API key, read from a hidden prompt or stdin, or a command whose output is the key',
  ),
)

const listText = (credentials: ReadonlyArray<CredentialInfo>): string => {
  if (credentials.length === 0)
    return 'no credentials: set one with `fabrica credentials set <name>`, or sign in with `fabrica credentials login <provider>`'
  const names = credentials.map(({ name }) => sanitiseLine(name))
  const width = Math.max(...names.map(name => name.length))
  return credentials
    .map(({ kind, provider }, index) =>
      [
        (names[index] ?? '').padEnd(width),
        kind,
        ...Option.toArray(Option.map(provider, sanitiseLine)),
      ].join('  '),
    )
    .join('\n')
}

const list = Command.make('list', {}, () =>
  withEngine(client => client.rpc['credentials.list']()).pipe(
    Effect.catchTag('CredentialStoreFailed', ({ reason }) =>
      Effect.fail(refused(reason)),
    ),
    Effect.flatMap(value =>
      printAnswer({
        schema: Schema.Array(CredentialInfo),
        value,
        text: listText,
      }),
    ),
  ),
).pipe(Command.withDescription('The credentials, by name'))

const RemovedAnswer = Schema.Struct({ removed: CredentialName })

const remove = Command.make('remove', { name: nameArgument }, ({ name }) =>
  withEngine(client => client.rpc['credentials.remove']({ name })).pipe(
    Effect.catchTags({
      CredentialNotFound: () =>
        Effect.fail(
          refused(`the engine has no credential named ${sanitiseLine(name)}`),
        ),
      CredentialStoreFailed: ({ reason }) => Effect.fail(refused(reason)),
    }),
    Effect.andThen(
      printAnswer({
        schema: RemovedAnswer,
        value: { removed: name },
        text: ({ removed }) => `removed ${sanitiseLine(removed)}`,
      }),
    ),
  ),
).pipe(Command.withDescription('Removes a credential'))

type Asked = Extract<LoginStep, { readonly _tag: 'asked' }>

/** A question and its choices, as lines. */
const askedLines = ({ message, choices }: Asked): ReadonlyArray<string> => [
  sanitiseLine(message),
  ...choices.map(
    ({ id, label }) => `  ${sanitiseLine(id)}: ${sanitiseLine(label)}`,
  ),
]

/** The answer typed at the terminal: chosen, unseen, or as it is typed; none where the prompt is left. */
const atTerminal = ({
  message,
  choices,
  secret,
}: Asked): Effect.Effect<Option.Option<string>, never, Prompt.Environment> => {
  const prompt: Prompt.Prompt<string> =
    choices.length > 0
      ? Prompt.Select({
          message,
          choices: choices.map(({ id, label }) => ({
            title: label,
            value: id,
          })),
        })
      : secret
        ? Prompt.map(Prompt.Hidden({ message }), Redacted.value)
        : Prompt.String({ message })
  return prompt.pipe(
    Effect.map(answer => Option.some(answer)),
    Effect.catchTag('QuitError', () => Effect.succeed(Option.none<string>())),
  )
}

/** The lines of a step that are printed as they are, with no answer asked. */
const stepLines = (step: LoginStep): ReadonlyArray<string> =>
  LoginStep.match(step, {
    terms: ({ text }) => [sanitiseLine(text)],
    open_url: ({ url, instructions }) => [
      `open ${sanitiseLine(url)}`,
      ...Option.toArray(Option.map(instructions, sanitiseLine)),
    ],
    device_code: ({ url, code }) => [
      `enter ${sanitiseLine(code)} at ${sanitiseLine(url)}`,
    ],
    waiting: ({ text }) => [sanitiseLine(text)],
    asked: askedLines,
    signed_in: ({ account }) => [
      Option.match(account, {
        onNone: () => 'signed in',
        onSome: name =>
          `signed in: the engine keeps it as ${sanitiseLine(name)}`,
      }),
    ],
  })

const encodeStep = Schema.encodeSync(LoginStep)

/** Answers a question the sign-in asks; one it went past takes no answer, which is no failure. */
const answering = (client: EngineClientShape, asked: Asked, answer: string) =>
  client.rpc['credentials.answerLogin']({
    login: asked.login,
    answer: Redacted.make(answer),
  }).pipe(Effect.catchTag('LoginNotWaiting', () => Effect.void))

const providersText = SignInProviders.map(
  ({ provider, label }) => `${provider} (${label})`,
).join(', ')

const login = Command.make(
  'login',
  {
    provider: Argument.String('provider').pipe(
      Argument.withDescription(`The provider to sign in to: ${providersText}`),
      Argument.withSchema(ProviderName),
    ),
  },
  ({ provider }) =>
    Effect.gen(function* () {
      const json = yield* Json
      const stdio = yield* Stdio.Stdio
      const onTerminal = yield* stdio.stdinIsTerminal
      const lines = yield* Effect.cached(stdinLines)
      /** Answers a question at the terminal, or from stdin's next line; none takes it where stdin ended. */
      const answerOf = (
        asked: Asked,
      ): Effect.Effect<
        Option.Option<string>,
        never,
        Prompt.Environment | Scope.Scope | Stdio.Stdio
      > =>
        onTerminal
          ? atTerminal(asked)
          : Effect.flatMap(lines, Queue.take).pipe(
              Effect.map(answer => Option.some(answer)),
              Effect.catchTag('Done', () =>
                Effect.succeed(Option.none<string>()),
              ),
            )
      const shown = (step: LoginStep) =>
        json
          ? Console.log(JSON.stringify(encodeStep(step)))
          : step._tag === 'asked' && onTerminal
            ? Effect.void
            : Console.log(stepLines(step).join('\n'))
      yield* withEngine(client =>
        client.rpc['credentials.login']({ provider }).pipe(
          Stream.runForEach(step =>
            Effect.andThen(
              shown(step),
              step._tag === 'asked'
                ? // Asked beside the stream: a browser's sign-in can overtake the question.
                  Effect.asVoid(
                    Effect.forkScoped(
                      Effect.flatMap(answerOf(step), answer =>
                        Option.isSome(answer)
                          ? answering(client, step, answer.value)
                          : Effect.void,
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        ),
      ).pipe(
        Effect.catchTag('LoginFailed', ({ reason }) =>
          Effect.fail(
            refused(
              `the sign-in to ${sanitiseLine(provider)} failed: ${sanitiseLine(reason)}`,
            ),
          ),
        ),
      )
    }).pipe(Effect.scoped),
).pipe(Command.withDescription('Signs in to a subscription'))

export const credentials = Command.make('credentials').pipe(
  Command.withDescription("Model credentials in the engine's secret store"),
  Command.withSubcommands([set, list, remove, login]),
)
