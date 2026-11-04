import { Data, Effect, Option, Redacted, Schema, Stdio } from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'

import {
  EngineAddress,
  FingerprintAnswer,
  SshDestination,
  type TlsEndpoint,
  WslDistro,
  parseTlsEndpoint,
  tlsEndpointText,
} from '@fabrica/client'
import { readFingerprint } from '@fabrica/client/node'
import { CertificateFingerprint } from '@fabrica/contracts'

import { secretFromUser } from './credentials'
import {
  EngineReach,
  type KnownEngine,
  KnownEngineExists,
  KnownEngineName,
  addKnownEngine,
  findKnownEngine,
  knownEngines,
  localEngineName,
  removeKnownEngine,
} from './known-engines'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica engine add|list|remove` (spec §19, §9.3): the engines `--engine <name>` knows by name. Adding
// one reaches nothing where it needn't: an SSH destination or a WSL2 distribution is kept as given, and
// ssh or wsl.exe says what is wrong at its first use. An engine over TLS is paired as the app pairs one:
// the user accepts the fingerprint of the certificate it presents, having compared it with what
// `fabrica engine status` prints on its host, or gives that fingerprint with `--fingerprint`, as a
// script must; its token is typed unseen, or read from stdin. No token is ever printed.

/** What was asked of the known engines can't be done. */
export class KnownEngineRefused extends Data.TaggedError('KnownEngineRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

const refused = (reason: string) => new KnownEngineRefused({ reason })

type Fingerprint = typeof CertificateFingerprint.Type

const nameArgument = Argument.String('name').pipe(
  Argument.withDescription(
    `The engine's name, one word, for --engine; ${localEngineName} is the local engine's`,
  ),
  Argument.withSchema(KnownEngineName),
)

/** A known engine as it is printed: how it is reached, never its token. */
const ListedEngine = Schema.Struct({
  name: KnownEngineName,
  address: EngineAddress,
})
type ListedEngine = typeof ListedEngine.Type

const addressOf = (reach: EngineReach): EngineAddress =>
  EngineReach.match<EngineAddress>(reach, {
    Ssh: ({ destination }) => EngineAddress.cases.Ssh.make({ destination }),
    Wsl: ({ distro }) => EngineAddress.cases.Wsl.make({ distro }),
    Tls: ({ host, port, fingerprint }) =>
      EngineAddress.cases.Tls.make({ host, port, fingerprint }),
  })

const listed = ({ name, reach }: KnownEngine): ListedEngine => ({
  name,
  address: addressOf(reach),
})

const addressText = (address: EngineAddress): string =>
  EngineAddress.match(address, {
    Local: () => 'its local socket',
    Ssh: ({ destination }) => `ssh ${sanitiseLine(destination)}`,
    Wsl: ({ distro }) => `wsl ${sanitiseLine(distro)}`,
    Tls: ({ host, port, fingerprint }) =>
      `tls ${sanitiseLine(tlsEndpointText({ host, port }))}, certificate SHA-256 ${fingerprint}`,
  })

/**
 * The fingerprint to pin for the engine at `endpoint`: the one given, or the one it presents where the
 * user accepts it on the terminal. Elsewhere nobody can accept it: it is refused, saying what it is.
 */
const acceptedFingerprint = (
  endpoint: TlsEndpoint,
  given: Option.Option<Fingerprint>,
) =>
  Option.match(given, {
    onSome: fingerprint => Effect.succeed(fingerprint),
    onNone: () =>
      Effect.gen(function* () {
        const at = sanitiseLine(tlsEndpointText(endpoint))
        const answer = yield* readFingerprint(endpoint)
        const fingerprint = yield* FingerprintAnswer.match<
          Effect.Effect<Fingerprint, KnownEngineRefused>
        >(answer, {
          Presented: ({ fingerprint }) => Effect.succeed(fingerprint),
          Failed: ({ reason }) => Effect.fail(refused(reason)),
        })
        const stdio = yield* Stdio.Stdio
        if (!(yield* stdio.stdinIsTerminal)) {
          return yield* refused(
            `the engine at ${at} presents the certificate SHA-256 ${fingerprint}: compare it with what \`fabrica engine status\` prints on its host, and give it with --fingerprint`,
          )
        }
        const accepted = yield* Prompt.Confirm({
          message: `The engine at ${at} presents the certificate SHA-256 ${fingerprint}. Is it the one \`fabrica engine status\` prints on its host?`,
        }).pipe(Effect.catchTag('QuitError', () => Effect.succeed(false)))
        return accepted
          ? fingerprint
          : yield* refused(
              `the certificate of the engine at ${at} wasn't accepted: nothing was kept`,
            )
      }),
  })

/** How an engine over TLS is reached: its pin, and its token, the last thing asked. */
const tlsReach = (address: string, given: Option.Option<Fingerprint>) =>
  Effect.gen(function* () {
    const endpoint = yield* Option.match(parseTlsEndpoint(address), {
      onNone: () =>
        Effect.fail(
          refused(
            `${sanitiseLine(address)} is no TLS address: give host:port, or [v6]:port`,
          ),
        ),
      onSome: Effect.succeed,
    })
    const fingerprint = yield* acceptedFingerprint(endpoint, given)
    const token = yield* secretFromUser(
      `The pairing token of ${sanitiseLine(tlsEndpointText(endpoint))}, from \`fabrica token create\``,
    )
    if (token === '') {
      return yield* refused(
        'no pairing token was given: make one with `fabrica token create <name>` on the host',
      )
    }
    if (/\s/u.test(token)) {
      return yield* refused(
        'a pairing token is one word: give the token alone, as `fabrica token create` printed it',
      )
    }
    return EngineReach.cases.Tls.make({
      ...endpoint,
      fingerprint,
      token: Redacted.make(token),
    })
  })

/** How the flags say the engine is reached: by exactly one of them. */
const reachFromFlags = ({
  ssh,
  wsl,
  tls,
  fingerprint,
}: {
  readonly ssh: Option.Option<SshDestination>
  readonly wsl: Option.Option<WslDistro>
  readonly tls: Option.Option<string>
  readonly fingerprint: Option.Option<Fingerprint>
}) => {
  if (Option.isNone(tls) && Option.isSome(fingerprint)) {
    return Effect.fail(refused('--fingerprint goes with --tls'))
  }
  const [only, ...others] = [
    ...Option.toArray(ssh).map(destination =>
      Effect.succeed(EngineReach.cases.Ssh.make({ destination })),
    ),
    ...Option.toArray(wsl).map(distro =>
      Effect.succeed(EngineReach.cases.Wsl.make({ distro })),
    ),
    ...Option.toArray(tls).map(address => tlsReach(address, fingerprint)),
  ]
  return only === undefined || others.length > 0
    ? Effect.fail(
        refused('say how the engine is reached: one of --ssh, --wsl or --tls'),
      )
    : only
}

export const addEngine = Command.make(
  'add',
  {
    name: nameArgument,
    ssh: Flag.String('ssh').pipe(
      Flag.withDescription(
        'Reached through ssh: user@host, a host of ~/.ssh/config, or ssh://[user@]host[:port]',
      ),
      Flag.withSchema(SshDestination),
      Flag.optional,
    ),
    wsl: Flag.String('wsl').pipe(
      Flag.withDescription('Reached through wsl.exe: a WSL2 distribution'),
      Flag.withSchema(WslDistro),
      Flag.optional,
    ),
    tls: Flag.String('tls').pipe(
      Flag.withDescription(
        'Reached over TLS: host:port, its token typed unseen or read from stdin',
      ),
      Flag.optional,
    ),
    fingerprint: Flag.String('fingerprint').pipe(
      Flag.withDescription(
        "With --tls, the engine's certificate's SHA-256 fingerprint, as `fabrica engine status` prints it; else it is asked on the terminal",
      ),
      Flag.withSchema(CertificateFingerprint),
      Flag.optional,
    ),
  },
  ({ name, ...flags }) =>
    Effect.gen(function* () {
      // Before anything is asked; adding it checks again, as the asking takes its time.
      if (Option.isSome(yield* findKnownEngine(name))) {
        return yield* new KnownEngineExists({ name })
      }
      const engine = { name, reach: yield* reachFromFlags(flags) }
      yield* addKnownEngine(engine)
      yield* printAnswer({
        schema: ListedEngine,
        value: listed(engine),
        text: ({ name, address }) =>
          `added ${sanitiseLine(name)}: ${addressText(address)}; reach it with \`--engine ${sanitiseLine(name)}\``,
      })
    }),
).pipe(
  Command.withDescription(
    'Keeps an engine under a name for --engine: on another host, in WSL2, or paired over TLS',
  ),
)

const listText = (engines: ReadonlyArray<ListedEngine>): string => {
  if (engines.length === 0)
    return 'no known engines: add one with `fabrica engine add <name>`'
  const names = engines.map(({ name }) => sanitiseLine(name))
  const width = Math.max(...names.map(name => name.length))
  return engines
    .map(
      ({ address }, index) =>
        `${(names[index] ?? '').padEnd(width)}  ${addressText(address)}`,
    )
    .join('\n')
}

export const listEngines = Command.make('list', {}, () =>
  knownEngines.pipe(
    Effect.flatMap(engines =>
      printAnswer({
        schema: Schema.Array(ListedEngine),
        value: engines.map(listed),
        text: listText,
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    'The engines --engine knows by name, and how each is reached',
  ),
)

const RemovedAnswer = Schema.Struct({ removed: KnownEngineName })

export const removeEngine = Command.make(
  'remove',
  { name: nameArgument },
  ({ name }) =>
    removeKnownEngine(name).pipe(
      Effect.andThen(
        printAnswer({
          schema: RemovedAnswer,
          value: { removed: name },
          text: ({ removed }) =>
            `removed ${sanitiseLine(removed)}: its token too; the engine itself is left as it is`,
        }),
      ),
    ),
).pipe(Command.withDescription('Forgets a known engine, and its token'))
