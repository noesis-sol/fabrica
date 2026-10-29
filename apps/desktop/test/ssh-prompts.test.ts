import { Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { SshPromptAnswer, SshPromptEvent } from '@fabrica/client'

import { askpassArguments, askpassNodeOf } from '../src/connection/askpass'
import { type MainIpc, registerIpc } from '../src/main/ipc'
import { askpassNode, makePromptDesk } from '../src/main/ssh-prompts'
import { type PreloadIpc, channels, makeApi } from '../src/preload/api'

// Main's and the preload's part in ssh's prompts (spec §9.1): main holds each prompt the connection
// process asks until the page answers it or it is withdrawn, and asks the page again at each load; the
// preload and main decode both ways; the askpass helper runs on the Node the app has.

const encodeEvent = Schema.encodeSync(SshPromptEvent)

const asked = (id: number) =>
  encodeEvent(
    SshPromptEvent.cases.Asked.make({
      id,
      prompt: {
        _tag: 'Secret',
        destination: 'u@server-1',
        text: 'Password:',
      },
    }),
  )
const withdrawn = (id: number) =>
  encodeEvent(SshPromptEvent.cases.Withdrawn.make({ id }))

/** Main's desk, recording what it sends the page and the connection process. */
const recordedDesk = () => {
  const toPage: Array<unknown> = []
  const toConnection: Array<unknown> = []
  const desk = makePromptDesk({
    toPage: event => toPage.push(event),
    toConnection: answer => toConnection.push(answer),
  })
  return { desk, toPage, toConnection }
}

describe("main's prompts", () => {
  it('asks the page, and hands its answer to the connection process once', () => {
    const { desk, toPage, toConnection } = recordedDesk()
    desk.fromConnection(asked(1))
    desk.fromConnection({ _tag: 'Asked', id: 'one' })
    desk.answer({ id: 1, answer: { _tag: 'Entered', secret: 'hunter2' } })
    desk.answer({ id: 1, answer: { _tag: 'Entered', secret: 'again' } })
    desk.answer({ id: 7, answer: { _tag: 'Accepted' } })
    expect(toPage).toEqual([asked(1)])
    expect(toConnection).toEqual([
      { id: 1, answer: { _tag: 'Entered', secret: 'hunter2' } },
    ])
  })

  it('asks a page that loads again what is still unanswered', () => {
    const { desk, toPage } = recordedDesk()
    desk.fromConnection(asked(1))
    desk.fromConnection(asked(2))
    desk.fromConnection(withdrawn(1))
    toPage.length = 0
    desk.pageLoaded()
    expect(toPage).toEqual([asked(2)])
  })

  it('withdraws what a connection process that exited asked', () => {
    const { desk, toPage, toConnection } = recordedDesk()
    desk.fromConnection(asked(1))
    desk.connectionGone()
    desk.answer({ id: 1, answer: { _tag: 'Declined' } })
    desk.pageLoaded()
    expect(toPage).toEqual([asked(1), withdrawn(1)])
    expect(toConnection).toEqual([])
  })

  it('runs the helper on the Node the app has: none on Windows', () => {
    const resources = '/Applications/Fabrica.app/Contents/Resources'
    expect(
      askpassNode({ platform: 'darwin', packaged: true, resources }),
    ).toEqual(Option.some(`${resources}/engine/node/bin/node`))
    expect(
      askpassNode({ platform: 'linux', packaged: false, resources }),
    ).toEqual(Option.some('node'))
    expect(
      askpassNode({ platform: 'win32', packaged: true, resources }),
    ).toEqual(Option.none())
    const node = Option.some(`${resources}/engine/node/bin/node`)
    expect(askpassNodeOf(['electron', ...askpassArguments(node)])).toEqual(node)
    expect(askpassNodeOf(askpassArguments(Option.none()))).toEqual(
      Option.none(),
    )
  })
})

describe('the prompts across the preload', () => {
  it("hands the page main's prompts that decode, encoded, and main the page's answers", () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const sent: Array<ReadonlyArray<unknown>> = []
    const ipc: PreloadIpc = {
      send: (channel, ...values) => sent.push([channel, ...values]),
      invoke: () => Promise.reject(new Error('not this test’s')),
      on: (channel, listener) => {
        listeners.set(channel, value => listener(value, []))
        return () => listeners.delete(channel)
      },
    }
    const api = makeApi(ipc)
    const events: Array<unknown> = []
    api.sshPrompts.onEvent(event => events.push(event))
    listeners.get(channels.sshPrompt)?.(asked(1))
    listeners.get(channels.sshPrompt)?.({ _tag: 'Asked', id: 2 })
    expect(events).toEqual([asked(1)])
    api.sshPrompts.answer({ id: 1, answer: { _tag: 'Accepted' } })
    const answer = (value: unknown) =>
      Reflect.apply(api.sshPrompts.answer, undefined, [value])
    expect(() => answer({ id: 1, answer: { _tag: 'Maybe' } })).toThrow()
    expect(sent).toEqual([
      [channels.answerSshPrompt, { id: 1, answer: { _tag: 'Accepted' } }],
    ])
  })

  it("takes the app's page's answers that decode, and no other", () => {
    const listeners = new Map<
      string,
      (sender: string | undefined, values: ReadonlyArray<unknown>) => void
    >()
    const ipc: MainIpc = {
      on: (channel, listener) => listeners.set(channel, listener),
      handle: () => undefined,
    }
    const answers: Array<SshPromptAnswer> = []
    const unused = () => Promise.reject(new Error('not this test’s'))
    const app = 'file:///app/index.html'
    registerIpc({
      ipc,
      trusted: url => url === app,
      actions: {
        minimize: () => undefined,
        toggleMaximize: () => undefined,
        close: () => undefined,
        setTheme: () => undefined,
        notify: () => undefined,
        pickFolder: unused,
        version: '1.0.0',
        updateStatus: () => ({ _tag: 'Unavailable' }),
        installLoginService: unused,
        checkEngine: unused,
        installEngine: unused,
        answerSshPrompt: answer => answers.push(answer),
      },
    })
    const send = (sender: string | undefined, value: unknown) =>
      listeners.get(channels.answerSshPrompt)?.(sender, [value])
    const good = Schema.decodeUnknownSync(SshPromptAnswer)({
      id: 3,
      answer: { _tag: 'Entered', secret: 'hunter2' },
    })
    send(app, good)
    send('https://example.com/', good)
    send(app, { id: 3, answer: { _tag: 'Entered' } })
    expect(answers).toEqual([good])
  })
})
