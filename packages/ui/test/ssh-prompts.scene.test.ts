import { Effect, Option, Redacted, Schema, Stream } from 'effect'
import { RpcClientError } from 'effect/rpc'
import { Socket } from 'effect/socket'
import {
  Command,
  click,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  submit,
  type as typeInto,
} from 'foldkit/scene'

import { describe, expect, it, test } from '@effect/vitest'
import {
  ConnectionRefused,
  SshPrompt,
  SshPromptEvent,
  sshPromptsMember,
} from '@fabrica/client'
import { EngineId, protocolVersion } from '@fabrica/contracts'

import {
  AttemptFailure,
  Connection,
  attemptFailure,
  connectionRequirements,
} from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import {
  AnswerSshPrompt,
  type AskedPrompt,
  sshPromptHostOf,
} from '../src/app/ssh-prompts'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// What ssh asks as the app connects, and a connection it refuses (spec §9.1): an unknown host's key
// shown with its fingerprint, accepted or refused; a passphrase typed into a password field and sent;
// a prompt ssh withdrew dropped; the notices dismissed once the engine answers; a connection the
// connection process refused stopped, saying why, until the user tries again; and the prompts read
// from the preload.

const start: Model = initialModel({ platform: 'darwin', release: '0.0.0' })

const hostKey: AskedPrompt = {
  id: 1,
  prompt: SshPrompt.cases.HostKey.make({
    destination: 'u@server-1',
    host: 'server-1 (192.0.2.7)',
    fingerprint: Option.some('SHA256:abc123'),
    text: "The authenticity of host 'server-1 (192.0.2.7)' can't be established.",
  }),
}

const passphrase: AskedPrompt = {
  id: 2,
  prompt: SshPrompt.cases.Secret.make({
    destination: 'u@server-1',
    text: "Enter passphrase for key '/home/u/.ssh/id_ed25519':",
  }),
}

const touch: AskedPrompt = {
  id: 3,
  prompt: SshPrompt.cases.Notice.make({
    destination: 'u@server-1',
    text: 'Confirm user presence for key ED25519-SK',
  }),
}

const asking = (...prompts: ReadonlyArray<AskedPrompt>): Model =>
  prompts.reduce(
    (model, { id, prompt }) =>
      update(model, Message.AskedSsh({ id, prompt })).model,
    start,
  )

const prompt = role('dialog', { name: 'SSH u@server-1' })

describe('what ssh asks', () => {
  test("shows an unknown host's key with its fingerprint, and sends the user's yes", () => {
    scene(
      { update, view },
      given(asking(hostKey)),
      expectScene(prompt).toContainText('server-1 (192.0.2.7)'),
      expectScene(selector('[aria-label="Fingerprint"]')).toHaveText(
        'SHA256:abc123',
      ),
      click(role('button', { name: 'Accept the key' })),
      Command.resolve(
        AnswerSshPrompt({
          id: 1,
          reply: 'Accepted',
          secret: Redacted.make(''),
        }),
        Message.CompletedAnswerSsh(),
      ),
      expectScene(prompt).toBeAbsent(),
    )
  })

  test('sends a passphrase typed, then shows the next prompt', () => {
    const typed = update(
      asking(passphrase, hostKey),
      Message.ChangedSshSecret({ secret: Redacted.make('hunter2') }),
    ).model
    const sent = update(
      typed,
      Message.RepliedToSsh({ id: 2, reply: 'Entered' }),
    )
    expect(
      sent.commands?.map(({ name, args }) => ({
        name,
        id: args?.['id'],
        reply: args?.['reply'],
        secret: Redacted.value(
          Schema.decodeUnknownSync(Schema.Redacted(Schema.String))(
            args?.['secret'],
          ),
        ),
      })),
    ).toEqual([
      { name: 'AnswerSshPrompt', id: 2, reply: 'Entered', secret: 'hunter2' },
    ])
    // The secret goes with its prompt.
    expect(Redacted.value(sent.model.sshPrompts.secret)).toBe('')
    expect(sent.model.sshPrompts.asked).toEqual([hostKey])
  })

  test('takes the passphrase in a password field', () => {
    scene(
      { update, view },
      given(asking(passphrase)),
      expectScene(selector('#ssh-secret')).toHaveAttr('type', 'password'),
      typeInto(selector('#ssh-secret'), 'hunter2'),
      submit(role('form', { name: 'SSH secret' })),
      Command.resolve(
        AnswerSshPrompt({
          id: 2,
          reply: 'Entered',
          secret: Redacted.make('hunter2'),
        }),
        Message.CompletedAnswerSsh(),
      ),
      expectScene(prompt).toBeAbsent(),
    )
  })

  test('drops a prompt ssh withdrew, and sends nothing for it', () => {
    const withdrawn = update(asking(hostKey), Message.WithdrewSsh({ id: 1 }))
    expect(withdrawn.model.sshPrompts.asked).toEqual([])
    const replied = update(
      withdrawn.model,
      Message.RepliedToSsh({ id: 1, reply: 'Accepted' }),
    )
    expect(replied.commands ?? []).toEqual([])
  })

  test('dismisses the notices once the engine answers', () => {
    const connected = update(
      asking(touch, hostKey),
      Message.ConnectedToEngine({
        engine: EngineId.make('e-1'),
        release: '0.1.0',
        protocol: protocolVersion,
      }),
    )
    expect(connected.model.sshPrompts.asked).toEqual([hostKey])
    expect(
      (connected.commands ?? []).flatMap(({ name, args }) =>
        name === 'AnswerSshPrompt'
          ? [{ id: args?.['id'], reply: args?.['reply'] }]
          : [],
      ),
    ).toEqual([{ id: 3, reply: 'Declined' }])
  })
})

const refusal =
  "the host key of u@server-1 has changed, so ssh refused the connection: check the new key with the host's administrator, then replace the old one in known_hosts"

describe('a connection the connection process refused', () => {
  test('stops, saying why, until the user tries again', () => {
    const stopped = update(
      start,
      Message.StoppedConnecting({ reason: refusal }),
    )
    expect(stopped.commands ?? []).toEqual([])
    expect(connectionRequirements(stopped.model)).toEqual(Option.none())
    // A new port doesn't mend it.
    expect(update(stopped.model, Message.ReplacedEnginePort()).model).toEqual(
      stopped.model,
    )
    scene(
      { update, view },
      given(stopped.model),
      expectScene(role('status')).toContainText(
        `Couldn't reach the engine: ${refusal}.`,
      ),
      click(role('button', { name: 'Try again' })),
      expectScene(role('status')).toContainText('Connecting to the engine…'),
    )
    const again = update(stopped.model, Message.RequestedReconnect()).model
    expect(again.attempt).toBe(start.attempt + 1)
    expect(again.connection).toEqual(Connection.Connecting())
  })

  test("is told from the client's error, by the refusal it carries", () => {
    const refused = new ConnectionRefused({ reason: refusal })
    const failed = new RpcClientError.RpcClientError({
      reason: new Socket.SocketReadError({ cause: refused }),
    })
    expect(attemptFailure(failed)).toEqual(
      AttemptFailure.Stopped({ reason: refusal }),
    )
    const lost = new RpcClientError.RpcClientError({
      reason: new Socket.SocketReadError({ cause: new Error('lost') }),
    })
    expect(AttemptFailure.$is('Unreachable')(attemptFailure(lost))).toBe(true)
  })
})

describe("the preload's prompts", () => {
  it.effect('are read as they decode, and answered encoded', () =>
    Effect.gen(function* () {
      const encode = Schema.encodeSync(SshPromptEvent)
      const answers: Array<unknown> = []
      const host = sshPromptHostOf({
        fabrica: {
          [sshPromptsMember]: {
            // Main has asked, and withdrawn, by the time the page listens.
            onEvent: (listener: (event: unknown) => void) => {
              listener({ _tag: 'Asked', id: 'one' })
              listener(encode(SshPromptEvent.cases.Asked.make(hostKey)))
              listener(encode(SshPromptEvent.cases.Withdrawn.make({ id: 1 })))
              return () => undefined
            },
            answer: (answer: unknown) => answers.push(answer),
          },
        },
      })
      expect(yield* Stream.runCollect(Stream.take(host.events, 2))).toEqual([
        SshPromptEvent.cases.Asked.make(hostKey),
        SshPromptEvent.cases.Withdrawn.make({ id: 1 }),
      ])
      yield* host.answer({ id: 1, answer: { _tag: 'Accepted' } })
      expect(answers).toEqual([{ id: 1, answer: { _tag: 'Accepted' } }])
      const none = sshPromptHostOf({})
      yield* none.answer({ id: 1, answer: { _tag: 'Accepted' } })
    }),
  )
})
