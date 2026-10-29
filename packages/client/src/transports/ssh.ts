import {
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Socket, type SocketServer } from 'effect/socket'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'

import type { SshDestination } from '../destination'
import {
  type BridgeCommand,
  type BridgeEnd,
  bridgeBackOff,
  bridgeSocket,
} from './bridge'

// The SSH stdio bridge (spec §8.2, §9.1, H30): the system's `ssh <destination> fabrica bridge`, with the
// user's own config, keys and agent, the RPC over its stdin and stdout. One ssh process per connection
// carries every stream; nothing is forwarded and no port opens. Keepalives (`ServerAliveInterval`) find
// a dead link, which ends the connection, and the client reconnects (running ssh again) and resumes its
// streams. Host keys are SSH's own (`known_hosts`): a changed key is refused, as ssh refuses it, and so is
// an unknown one the user didn't accept; neither is tried again (`sshReconnect`). How ssh asks for what
// it needs (an unknown host's key, a passphrase, a password) is the caller's `prompting`: on the terminal,
// as ssh asks; not at all; or relayed to the caller through `SSH_ASKPASS`, which takes OpenSSH 8.4 or
// later (`SSH_ASKPASS_REQUIRE=force`; on Windows the only way, fab-mgi.13).

/** An unknown host's key, as ssh asks to accept it. */
export interface HostKeyPrompt {
  readonly destination: string
  /** The host as ssh names it, its address included: `server-1 (192.0.2.7)`. */
  readonly host: string
  /** The key's fingerprint, `SHA256:…`, where ssh gave it. */
  readonly fingerprint: Option.Option<string>
  /** ssh's whole question. */
  readonly text: string
}

/** Anything else ssh asks or says: a passphrase, a password, a confirmation, a notice. */
export interface TextPrompt {
  readonly destination: string
  /** ssh's text. */
  readonly text: string
}

/** The caller's answers to what ssh asks, relayed through `SSH_ASKPASS`. */
export interface SshPrompts {
  /** Whether to accept an unknown host's key; ssh then adds it to `known_hosts`. */
  readonly hostKey: (prompt: HostKeyPrompt) => Effect.Effect<boolean>
  /** A key's passphrase, a password or a keyboard-interactive answer; none cancels. */
  readonly secret: (
    prompt: TextPrompt,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>
  /** A yes or no, as ssh-agent's confirmation of a key's use asks. */
  readonly confirm: (prompt: TextPrompt) => Effect.Effect<boolean>
  /** Something to show while ssh waits, such as a security key's touch. */
  readonly notice: (prompt: TextPrompt) => Effect.Effect<void>
}

/** How ssh asks for what it needs. */
export type SshPrompting = Data.TaggedEnum<{
  /** As ssh asks: on the controlling terminal, the CLI's. */
  Terminal: {}
  /** Never (`BatchMode`): only keys ssh-agent holds, and hosts `known_hosts` knows. */
  None: {}
  /**
   * Relayed to `prompts` through `SSH_ASKPASS`: a helper run by `node`, which ssh starts for each
   * prompt, in a private folder made under `folder` for each connection.
   */
  Relay: {
    readonly node: string
    readonly folder: string
    readonly prompts: SshPrompts
  }
}>
export const SshPrompting = Data.taggedEnum<SshPrompting>()

export interface SshOptions {
  readonly destination: SshDestination
  /** ssh's environment, the user's own, for their agent and config; the relay's variables go over it. */
  readonly env: Readonly<Record<string, string>>
  readonly prompting: SshPrompting
  /** The ssh to run: a path, or a name found on `env`'s PATH; `ssh` unless given. */
  readonly ssh?: string
  /** Seconds between keepalives, three of them unanswered ending the link: 15 unless given. */
  readonly keepalive?: number
  /** The command run on the host: `fabrica bridge` unless given. */
  readonly remote?: ReadonlyArray<string>
}

/** Why ssh ended a connection, from its exit and stderr. Every one but `Lost` is a refusal. */
export type SshFailure = Data.TaggedEnum<{
  /** The host's key isn't the one `known_hosts` has for it. */
  HostKeyChanged: { readonly detail: string }
  /** The host's key isn't known, and wasn't accepted (or couldn't be asked about). */
  HostKeyUnknown: { readonly detail: string }
  /** The host took none of the user's keys or passwords. */
  AuthenticationFailed: { readonly detail: string }
  /** The host has no `fabrica` on its PATH. */
  BridgeMissing: { readonly detail: string }
  /** This ssh can't relay prompts: it isn't OpenSSH 8.4 or later. */
  TooOld: { readonly version: string }
  /** The link failed or was lost: it is tried again. */
  Lost: { readonly detail: string }
}>
export const SshFailure = Data.taggedEnum<SshFailure>()

/** The oldest OpenSSH whose prompts can be relayed: `SSH_ASKPASS_REQUIRE` came in 8.4. */
export const askpassFloor = { major: 8, minor: 4 } as const

/** A connection to `destination` that ssh ended, and why: the cause of its socket's error. */
export class SshFailed extends Data.TaggedError('SshFailed')<{
  readonly destination: string
  readonly failure: SshFailure
}> {
  /** Whether trying again would end the same way. */
  get refused(): boolean {
    return !SshFailure.$is('Lost')(this.failure)
  }

  override get message() {
    const at = this.destination
    return SshFailure.$match(this.failure, {
      HostKeyChanged: () =>
        `the host key of ${at} has changed, so ssh refused the connection: check the new key with the host's administrator, then replace the old one in known_hosts`,
      HostKeyUnknown: () =>
        `the host key of ${at} is not known: connect once with \`ssh ${at}\` to check its fingerprint and accept it`,
      AuthenticationFailed: ({ detail }) =>
        `ssh could not sign in to ${at}: ${detail}`,
      BridgeMissing: () =>
        `${at} has no fabrica on its PATH: install the engine there`,
      TooOld: ({ version }) =>
        `this ssh is ${version}: the app relays ssh's prompts, which takes OpenSSH ${askpassFloor.major}.${askpassFloor.minor} or later; ${
          /for_Windows/u.test(version)
            ? 'install a newer Win32-OpenSSH, with `winget install Microsoft.OpenSSH.Preview` or from https://github.com/PowerShell/Win32-OpenSSH/releases, and put it first on the PATH'
            : 'install a newer OpenSSH, and put it first on the PATH'
        }`,
      Lost: ({ detail }) => `the ssh connection to ${at} failed: ${detail}`,
    })
  }
}

/** The SshFailed a connection's error carries, if ssh ended it. */
export const sshFailed = (
  error: Socket.SocketError | RpcClientError.RpcClientError,
): Option.Option<SshFailed> => {
  const { reason } = error
  return Predicate.hasProperty(reason, 'cause') &&
    reason.cause instanceof SshFailed
    ? Option.some(reason.cause)
    : Option.none()
}

/** The client's reconnect schedule over ssh: `base` (Effect's back-off unless given), until ssh refuses. */
export const sshReconnect = (
  base: Schedule.Schedule<unknown, Socket.SocketError> = bridgeBackOff,
): Schedule.Schedule<unknown, Socket.SocketError> =>
  Schedule.while(base, ({ input }) =>
    Option.match(sshFailed(input), {
      onNone: () => true,
      onSome: failed => !failed.refused,
    }),
  )

/** ssh's last few lines of stderr, joined: what it said last. */
const lastWords = (stderr: string): string =>
  stderr
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-3)
    .join(' ')

/** Why ssh ended, from its exit and what it printed (OpenSSH's own words); none for a clean end. */
export const sshEnded = (end: BridgeEnd): Option.Option<SshFailure> => {
  if (end.code === 0) {
    return Option.none()
  }
  const detail = lastWords(end.stderr)
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/u.test(
      end.stderr,
    )
  ) {
    return Option.some(SshFailure.HostKeyChanged({ detail }))
  }
  if (
    /Host key verification failed|No \S+ host key is known for/u.test(
      end.stderr,
    )
  ) {
    return Option.some(SshFailure.HostKeyUnknown({ detail }))
  }
  if (
    /Permission denied \(|Too many authentication failures/u.test(end.stderr)
  ) {
    return Option.some(SshFailure.AuthenticationFailed({ detail }))
  }
  // The host's shell found no such command.
  if (end.code === 127) {
    return Option.some(SshFailure.BridgeMissing({ detail }))
  }
  return Option.some(
    SshFailure.Lost({
      detail:
        detail === ''
          ? end.code === null
            ? `ssh was stopped by ${end.signal ?? 'a signal'}`
            : `ssh exited with ${end.code}`
          : detail,
    }),
  )
}

/** ssh's arguments for `options`: no terminal, nothing forwarded, keepalives on. */
export const sshArguments = (options: SshOptions): ReadonlyArray<string> => [
  '-T',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  // A master connection ssh started here would outlive the bridge, holding its pipes open.
  '-o',
  'ControlMaster=no',
  '-o',
  `ServerAliveInterval=${options.keepalive ?? 15}`,
  '-o',
  'ServerAliveCountMax=3',
  ...(SshPrompting.$is('None')(options.prompting)
    ? ['-o', 'BatchMode=yes']
    : []),
  '--',
  options.destination,
  ...(options.remote ?? ['fabrica', 'bridge']),
]

/** OpenSSH's version in `ssh -V`'s words: `OpenSSH_9.6p1 …`, `OpenSSH_for_Windows_8.1p1, …`. */
export const parseSshVersion = (
  text: string,
): Option.Option<{ readonly major: number; readonly minor: number }> => {
  const found = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/u.exec(text)
  return found === null
    ? Option.none()
    : Option.some({ major: Number(found[1]), minor: Number(found[2]) })
}

const openFailed = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
  })

/** Whether `ssh -V`'s words name an OpenSSH 8.4 or later, whose prompts can be relayed. */
const relaysPrompts = (said: string): boolean =>
  Option.exists(
    parseSshVersion(said),
    ({ major, minor }) =>
      major > askpassFloor.major ||
      (major === askpassFloor.major && minor >= askpassFloor.minor),
  )

/**
 * Checks that the ssh `options` run is OpenSSH 8.4 or later, from `ssh -V`: the app relays every prompt
 * through `SSH_ASKPASS`, so it takes no older one (fab-mgi.13), and says so at Add engine and connect.
 * It fails with SshFailed (`TooOld`), or with why `ssh -V` couldn't run.
 */
export const checkSshVersion = (options: {
  readonly destination: SshDestination
  readonly env: Readonly<Record<string, string>>
  readonly ssh?: string
}): Effect.Effect<void, SshFailed | Error> =>
  Effect.callback<void, SshFailed | Error>(resume => {
    execFile(
      options.ssh ?? 'ssh',
      ['-V'],
      { env: options.env },
      (error, stdout, stderr) => {
        const said = `${stderr}${stdout}`.trim()
        if (error !== null && said === '') {
          resume(Effect.fail(error))
          return
        }
        resume(
          relaysPrompts(said)
            ? Effect.void
            : Effect.fail(
                new SshFailed({
                  destination: options.destination,
                  failure: SshFailure.TooOld({
                    version: said.split(/[,\n]/u)[0] ?? said,
                  }),
                }),
              ),
        )
      },
    )
  })

// The relay. ssh runs `SSH_ASKPASS` with its prompt as the one argument (and `SSH_ASKPASS_PROMPT` set to
// `confirm` or `none` for a yes-or-no or a notice) and reads the answer from its stdout. The helper,
// written into the connection's private folder, sends the prompt as one JSON line to the connection's
// socket there and prints the answer it gets back; it never reads its stdin, which is the bridge's.

/** What the helper sends: ssh's prompt, and its `SSH_ASKPASS_PROMPT`. */
const AskpassRequest = Schema.Struct({
  prompt: Schema.String,
  hint: Schema.String,
})
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AskpassRequest),
)

/** What the helper gets back: the answer to print, or none, for ssh to take as cancelled. */
const AskpassReply = Schema.TaggedUnion({
  Answer: { text: Schema.String },
  Cancel: {},
})
type AskpassReply = typeof AskpassReply.Type
const encodeReply = Schema.encodeEffect(Schema.fromJsonString(AskpassReply))

/** The most a prompt may hold. */
const requestMaxBytes = 64 * 1024

/** The helper, run by Node: no imports but Node's own, and nothing read from stdin. */
const helperScript = `const net = process.getBuiltinModule('node:net')
const socket = net.connect(process.env.FABRICA_ASKPASS ?? '')
const chunks = []
process.exitCode = 1
socket.on('connect', () => {
  const request = { prompt: process.argv[2] ?? '', hint: process.env.SSH_ASKPASS_PROMPT ?? '' }
  socket.write(JSON.stringify(request) + '\\n')
})
socket.on('data', chunk => chunks.push(chunk))
socket.on('end', () => {
  try {
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (reply._tag === 'Answer' && typeof reply.text === 'string') {
      process.stdout.write(reply.text + '\\n')
      process.exitCode = 0
    }
  } catch {}
})
socket.on('error', () => {})
`

/** `text` quoted as one word for /bin/sh, and for the login shells ssh runs a command with. */
export const shQuote = (text: string): string =>
  `'${text.replaceAll("'", `'\\''`)}'`

/** The host and fingerprint of ssh's question about an unknown host's key, where it is one. */
const hostKeyQuestion = (
  prompt: string,
): Option.Option<Omit<HostKeyPrompt, 'destination' | 'text'>> => {
  const host = /The authenticity of host '([^']*)'/u.exec(prompt)
  if (host === null) {
    return Option.none()
  }
  // OpenSSH 10 writes `fingerprint is: SHA256:…`; earlier ones `fingerprint is SHA256:….`.
  const fingerprint = /key fingerprint is:? (\S+?)\.?$/mu.exec(prompt)
  return Option.some({
    host: host[1] ?? '',
    fingerprint: Option.fromNullishOr(fingerprint?.[1]),
  })
}

const answer = (text: string): AskpassReply =>
  AskpassReply.cases.Answer.make({ text })
const cancel: AskpassReply = AskpassReply.cases.Cancel.make({})

/** The reply to one request of the helper's, asked of `prompts`. */
const replyTo = (
  request: typeof AskpassRequest.Type,
  prompts: SshPrompts,
  destination: string,
): Effect.Effect<AskpassReply> => {
  const text = request.prompt
  if (request.hint === 'none') {
    return Effect.as(prompts.notice({ destination, text }), cancel)
  }
  if (request.hint === 'confirm') {
    return Effect.map(prompts.confirm({ destination, text }), yes =>
      yes ? answer('yes') : cancel,
    )
  }
  return Option.match(hostKeyQuestion(text), {
    onSome: question =>
      Effect.map(
        prompts.hostKey({ destination, text, ...question }),
        accepted => answer(accepted ? 'yes' : 'no'),
      ),
    onNone: () =>
      Effect.map(prompts.secret({ destination, text }), secret =>
        Option.match(secret, {
          onNone: () => cancel,
          onSome: value => answer(Redacted.value(value)),
        }),
      ),
  })
}

/** Reads the helper's one line from `socket`, asks `prompts`, and sends the reply. */
const serveHelper = (
  socket: Socket.Socket,
  prompts: SshPrompts,
  destination: string,
) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const decoder = new TextDecoder()
    let line = ''
    while (!line.includes('\n')) {
      const chunks = yield* reader.pull
      for (const chunk of chunks) {
        line +=
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, { stream: true })
      }
      if (line.length > requestMaxBytes) {
        return
      }
    }
    const request = yield* decodeRequest(line.slice(0, line.indexOf('\n')))
    const reply = yield* replyTo(request, prompts, destination)
    yield* writer.write(`${yield* encodeReply(reply)}\n`)
    yield* writer.write(new Socket.CloseEvent())
  }).pipe(
    // A helper that went away, or sent something else, gets nothing: ssh takes it as cancelled.
    Effect.ignore,
    Effect.scoped,
  )

const fileStep = (run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: openFailed })

/** The relay's variables for one connection: its private folder, helper and socket, gone with its scope. */
const openRelay = (
  relay: Extract<SshPrompting, { readonly _tag: 'Relay' }>,
  destination: string,
): Effect.Effect<
  Readonly<Record<string, string>>,
  Socket.SocketError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const folder = yield* Effect.acquireRelease(
      fileStep(() => mkdtemp(NodePath.join(relay.folder, 'ssh-'))).pipe(
        Effect.map(String),
      ),
      made => Effect.promise(() => rm(made, { recursive: true, force: true })),
    )
    const script = NodePath.join(folder, 'askpass.mjs')
    const helper = NodePath.join(folder, 'askpass')
    const path = NodePath.join(folder, 'ask.sock')
    yield* fileStep(() => writeFile(script, helperScript, { mode: 0o600 }))
    yield* fileStep(() =>
      writeFile(
        helper,
        `#!/bin/sh\nexec ${shQuote(relay.node)} ${shQuote(script)} "$@"\n`,
        { mode: 0o700 },
      ),
    )
    yield* fileStep(() => chmod(helper, 0o700))
    const server: SocketServer.SocketServer['Service'] =
      yield* NodeSocketServer.make({ path }).pipe(Effect.mapError(openFailed))
    yield* server
      .run(socket => serveHelper(socket, relay.prompts, destination))
      .pipe(Effect.ignore, Effect.forkScoped)
    return {
      SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: 'force',
      FABRICA_ASKPASS: path,
    }
  })

/** A socket over ssh to the engine at `options.destination`: each connection runs ssh anew. */
export const sshSocket = (options: SshOptions): Effect.Effect<Socket.Socket> =>
  Effect.gen(function* () {
    const checked = yield* Effect.cached(
      Effect.mapError(checkSshVersion(options), openFailed),
    )
    const ended = (end: BridgeEnd) =>
      Option.map(
        sshEnded(end),
        failure => new SshFailed({ destination: options.destination, failure }),
      )
    const open: Effect.Effect<BridgeCommand, Socket.SocketError, Scope.Scope> =
      SshPrompting.$match(options.prompting, {
        Terminal: () => Effect.succeed(options.env),
        None: () => Effect.succeed(options.env),
        Relay: relay =>
          Effect.andThen(
            checked,
            Effect.map(openRelay(relay, options.destination), relayed => ({
              ...options.env,
              ...relayed,
            })),
          ),
      }).pipe(
        Effect.map(env => ({
          command: options.ssh ?? 'ssh',
          args: sshArguments(options),
          env,
          ended,
        })),
      )
    return yield* bridgeSocket(open)
  })

/** The SSH bridge's `Socket`. Give the client `sshReconnect`, so it stops at a refusal. */
export const layerSsh = (options: SshOptions): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, sshSocket(options))
