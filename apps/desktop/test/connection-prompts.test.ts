import { Effect, Fiber, Option, Redacted, Schema } from 'effect'
import { readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import {
  SshPromptEvent,
  connectionRefused,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { makeAskedPrompts } from '../src/connection/prompts'
import { relay } from '../src/connection/relay'
import { ConnectionTarget } from '../src/connection/target'
import { engineSocket, refusalOf } from '../src/connection/transports'

// The connection process's end of ssh's prompts and refusals (spec §9.1): what ssh asks through
// `SSH_ASKPASS` is asked of main, numbered, and waited on until its answer comes, or withdrawn where ssh
// goes on without it; a connection ssh refuses reaches the page as refused, in ssh's words. The relay
// runs against a stub ssh that asks about an unknown host's key through the real askpass helper.

const decodeEvent = Schema.decodeUnknownSync(SshPromptEvent)

const hostKeyText = [
  "The authenticity of host 'server-1 (192.0.2.7)' can't be established.",
  'ED25519 key fingerprint is SHA256:abc123.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
].join('\n')

/** Asked prompts that record what they post, decoded. */
const recorded = () => {
  const posted: Array<SshPromptEvent> = []
  const asked = makeAskedPrompts(event => posted.push(decodeEvent(event)))
  return { posted, ...asked }
}

describe("the connection process's prompts", () => {
  it.effect("asks an unknown host's key, numbered, and takes the answer", () =>
    Effect.gen(function* () {
      const { posted, prompts, answered } = recorded()
      const fiber = yield* Effect.forkChild(
        prompts.hostKey({
          destination: 'u@server-1',
          host: 'server-1 (192.0.2.7)',
          fingerprint: Option.some('SHA256:abc123'),
          text: hostKeyText,
        }),
      )
      yield* Effect.yieldNow
      expect(posted).toEqual([
        SshPromptEvent.cases.Asked.make({
          id: 1,
          prompt: {
            _tag: 'HostKey',
            destination: 'u@server-1',
            host: 'server-1 (192.0.2.7)',
            fingerprint: Option.some('SHA256:abc123'),
            text: hostKeyText,
          },
        }),
      ])
      answered({ id: 1, answer: { _tag: 'Accepted' } })
      expect(yield* Fiber.join(fiber)).toBe(true)
    }),
  )

  it.effect('gives a secret entered, and none for a cancel', () =>
    Effect.gen(function* () {
      const { prompts, answered } = recorded()
      const ask = prompts.secret({
        destination: 'u@server-1',
        text: "Enter passphrase for key '/home/u/.ssh/id_ed25519':",
      })
      const entered = yield* Effect.forkChild(ask)
      yield* Effect.yieldNow
      answered({ id: 1, answer: { _tag: 'Entered', secret: 'hunter2' } })
      expect(Option.map(yield* Fiber.join(entered), Redacted.value)).toEqual(
        Option.some('hunter2'),
      )
      const cancelled = yield* Effect.forkChild(ask)
      yield* Effect.yieldNow
      answered({ id: 2, answer: { _tag: 'Declined' } })
      expect(yield* Fiber.join(cancelled)).toEqual(Option.none())
    }),
  )

  it.effect(
    'withdraws a prompt ssh no longer waits on, and drops its answer',
    () =>
      Effect.gen(function* () {
        const { posted, prompts, answered } = recorded()
        const fiber = yield* Effect.forkChild(
          prompts.confirm({
            destination: 'u@server-1',
            text: 'Allow use of key?',
          }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        answered({ id: 1, answer: { _tag: 'Accepted' } })
        expect(posted.map(event => event._tag)).toEqual(['Asked', 'Withdrawn'])
        expect(posted[1]).toEqual(
          SshPromptEvent.cases.Withdrawn.make({ id: 1 }),
        )
      }),
  )

  it.effect('tells a notice, waiting for nothing', () =>
    Effect.gen(function* () {
      const { posted, prompts } = recorded()
      yield* prompts.notice({
        destination: 'u@server-1',
        text: 'Confirm user presence for key ED25519-SK',
      })
      expect(posted.map(event => event._tag)).toEqual(['Asked'])
    }),
  )
})

/** A stub ssh: OpenSSH 9.6 to `-V`; else asks about the host's key through SSH_ASKPASS, refusing a no. */
const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'if [ "$1" = "-V" ]; then echo "OpenSSH_9.6p1, OpenSSL 3.0.13" >&2; exit 0; fi',
        `answer=$("$SSH_ASKPASS" "$STUB_PROMPT")`,
        'printf "%s" "$answer" > "$STUB_DIR/answer"',
        'echo "Host key verification failed." >&2',
        'exit 255',
      ].join('\n'),
    ),
  },
})

describe('a connection over ssh', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      "asks the user about an unknown host's key, and says ssh's refusal to the page",
      () =>
        Effect.gen(function* () {
          const tools = yield* Toolbox
          const dir = yield* tempFolder('ssh-prompts')
          const posted: Array<SshPromptEvent> = []
          const asked = makeAskedPrompts(event => {
            const decoded = decodeEvent(event)
            posted.push(decoded)
            // The user refuses the key.
            if (SshPromptEvent.guards.Asked(decoded)) {
              asked.answered({ id: decoded.id, answer: { _tag: 'Declined' } })
            }
          })
          const channel = yield* Effect.acquireRelease(
            Effect.sync(() => new MessageChannel()),
            ({ port1, port2 }) =>
              Effect.sync(() => {
                port1.close()
                port2.close()
              }),
          )
          yield* Effect.forkScoped(
            relay({
              port: webPortEnd(channel.port2),
              engine: engineSocket(
                ConnectionTarget.cases.Ssh.make({ destination: 'u@server-1' }),
                {
                  env: tools.env({ STUB_DIR: dir, STUB_PROMPT: hostKeyText }),
                  askpass: Option.some({
                    node: process.execPath,
                    folder: dir,
                    prompts: asked.prompts,
                  }),
                },
              ),
              refusal: refusalOf,
            }),
          )
          const socket = yield* portSocket(webPortEnd(channel.port1))
          const reader = yield* socket.reader
          const failed = yield* Effect.flip(reader.pull)
          expect(
            Option.map(connectionRefused(failed), ({ reason }) => reason),
          ).toEqual(
            Option.some(
              'the host key of u@server-1 is not known: connect once with `ssh u@server-1` to check its fingerprint and accept it',
            ),
          )
          expect(posted).toEqual([
            SshPromptEvent.cases.Asked.make({
              id: 1,
              prompt: {
                _tag: 'HostKey',
                destination: 'u@server-1',
                host: 'server-1 (192.0.2.7)',
                fingerprint: Option.some('SHA256:abc123'),
                text: hostKeyText,
              },
            }),
          ])
          expect(
            yield* Effect.promise(() =>
              readFile(NodePath.join(dir, 'answer'), 'utf8'),
            ),
          ).toBe('no')
        }).pipe(Effect.scoped),
    )
  })
})
