import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { AttentionRef, ProjectId, TicketId } from '@fabrica/contracts'
import { notifierOf } from '@fabrica/ui'
import {
  type DesktopNotification,
  NotificationTarget,
} from '@fabrica/ui/notify'

import { type MainActions, type MainIpc, registerIpc } from '../src/main/ipc'
import {
  type NotificationClass,
  type NotifiedPage,
  makeNotifications,
} from '../src/main/notifications'
import {
  FolderPick,
  type PreloadIpc,
  UpdateStatus,
  channels,
  makeApi,
} from '../src/preload/api'

// The app's system notifications (spec §18.5): the preload's validated `notify` and its clicks, main
// decoding them again, showing them while the window doesn't have focus, and a click bringing the
// window forward and handing its page the notification's target.

const project = ProjectId.make('p-fabrica')

const toQuestion = NotificationTarget.cases.Request.make({
  ref: AttentionRef.cases.question.make({
    project,
    ticket: TicketId.make('fa-q1'),
  }),
})

const question: DesktopNotification = {
  title: 'Question · fabrica',
  body: 'Which store keeps the sessions?',
  target: toQuestion,
}

/** A stand-in for Electron's Notification class: what was shown, and a click or a close on each. */
const fakeSystem = (supported = true) => {
  const shown: Array<{
    readonly title: string
    readonly body: string
    readonly click: () => void
    readonly close: () => void
  }> = []
  class FakeNotification {
    static isSupported = () => supported
    readonly #listeners = new Map<string, () => void>()
    constructor(
      readonly options: { readonly title: string; readonly body: string },
    ) {}
    on(event: 'click' | 'close', listener: () => void): this {
      this.#listeners.set(event, listener)
      return this
    }
    show(): void {
      shown.push({
        ...this.options,
        click: () => this.#listeners.get('click')?.(),
        close: () => this.#listeners.get('close')?.(),
      })
    }
  }
  const system: NotificationClass = FakeNotification
  return { system, shown }
}

/** A stand-in page: loaded or loading, and what main sent it. */
const fakePage = (loading: boolean) => {
  const sent: Array<readonly [string, NotificationTarget]> = []
  let onLoad: (() => void) | undefined
  const page: NotifiedPage = {
    isLoading: () => loading,
    once: (_event, listener) => {
      onLoad = listener
    },
    send: (channel, value) => sent.push([channel, value]),
  }
  return { page, sent, load: () => onLoad?.() }
}

describe('main’s notifications', () => {
  it('shows a notification while the window doesn’t have focus', () => {
    const { system, shown } = fakeSystem()
    makeNotifications({
      system,
      window: { hasFocus: () => false, reveal: () => undefined },
    }).notify(question)
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'Question · fabrica', body: 'Which store keeps the sessions?' },
    ])
  })

  it('shows none while the window has focus, or where the system has none', () => {
    const focused = fakeSystem()
    makeNotifications({
      system: focused.system,
      window: { hasFocus: () => true, reveal: () => undefined },
    }).notify(question)
    expect(focused.shown).toEqual([])

    const unsupported = fakeSystem(false)
    makeNotifications({
      system: unsupported.system,
      window: { hasFocus: () => false, reveal: () => undefined },
    }).notify(question)
    expect(unsupported.shown).toEqual([])
  })

  it('on a click, brings the window forward and hands its page the target', () => {
    const { system, shown } = fakeSystem()
    const { page, sent } = fakePage(false)
    let revealed = 0
    makeNotifications({
      system,
      window: {
        hasFocus: () => false,
        reveal: () => {
          revealed += 1
          return page
        },
      },
    }).notify(question)
    shown[0]?.click()
    expect(revealed).toBe(1)
    expect(sent).toEqual([[channels.notificationClicked, toQuestion]])
  })

  it('hands a window made again by the click the target once its page has loaded', () => {
    const { system, shown } = fakeSystem()
    const { page, sent, load } = fakePage(true)
    makeNotifications({
      system,
      window: { hasFocus: () => false, reveal: () => page },
    }).notify(question)
    shown[0]?.click()
    expect(sent).toEqual([])
    load()
    expect(sent).toEqual([[channels.notificationClicked, toQuestion]])
  })

  it('a click with no window to show sends nothing, and a closed notification nothing either', () => {
    const { system, shown } = fakeSystem()
    makeNotifications({
      system,
      window: { hasFocus: () => false, reveal: () => undefined },
    }).notify(question)
    expect(() => shown[0]?.close()).not.toThrow()
    expect(() => shown[0]?.click()).not.toThrow()
  })
})

/** A stand-in ipcRenderer: what was sent, messages to deliver, and those `waiting` for the first listener on their channel. */
const fakeRendererIpc = (waiting: Record<string, unknown> = {}) => {
  const sent: Array<ReadonlyArray<unknown>> = []
  const listeners = new Map<
    string,
    Set<(value: unknown, ports: ReadonlyArray<unknown>) => void>
  >()
  const ipc: PreloadIpc = {
    send: (channel, ...values) => sent.push([channel, ...values]),
    invoke: () => Promise.reject(new Error('no requests here')),
    on: (channel, listener) => {
      const forChannel = listeners.get(channel) ?? new Set()
      forChannel.add(listener)
      listeners.set(channel, forChannel)
      if (channel in waiting) {
        listener(waiting[channel], [])
      }
      return () => {
        forChannel.delete(listener)
      }
    },
  }
  const deliver = (channel: string, value: unknown) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener(value, [])
    }
  }
  return { ipc, sent, deliver }
}

describe('the preload’s notifications', () => {
  it('sends a notification that decodes, and throws on one that doesn’t', () => {
    const { ipc, sent } = fakeRendererIpc()
    const api = makeApi(ipc)
    api.notifications.notify(question)
    // The page is untrusted: what it passes is checked whatever its types say.
    const notify = (value: unknown) =>
      Reflect.apply(api.notifications.notify, undefined, [value])
    expect(() => notify({ ...question, title: '' })).toThrow()
    expect(() => notify({ ...question, title: 'x'.repeat(121) })).toThrow()
    expect(() => notify({ ...question, body: 'x'.repeat(501) })).toThrow()
    expect(() =>
      notify({ ...question, target: { _tag: 'Open', url: 'https://x' } }),
    ).toThrow()
    expect(() => notify('Question')).toThrow()
    expect(sent).toEqual([[channels.notify, question]])
  })

  it('passes on each clicked target that decodes, until stopped', () => {
    const { ipc, deliver } = fakeRendererIpc()
    const seen: Array<NotificationTarget> = []
    const stop = makeApi(ipc).notifications.onClick(target => seen.push(target))
    deliver(channels.notificationClicked, toQuestion)
    deliver(channels.notificationClicked, { _tag: 'Request', ref: 'fa-q1' })
    deliver(channels.notificationClicked, { _tag: 'Project', project })
    stop()
    deliver(channels.notificationClicked, toQuestion)
    expect(seen).toEqual([
      toQuestion,
      NotificationTarget.cases.Project.make({ project }),
    ])
  })

  it('reaches the renderer as its notifier: shown, and the clicks as a stream', async () => {
    const { ipc, sent } = fakeRendererIpc({
      [channels.notificationClicked]: toQuestion,
    })
    const notifier = notifierOf(makeApi(ipc).notifications)
    await Effect.runPromise(notifier.notify(question))
    expect(sent).toEqual([[channels.notify, question]])

    const clicks = await Effect.runPromise(
      Stream.runCollect(Stream.take(notifier.clicks, 1)),
    )
    expect(clicks).toEqual([toQuestion])
  })
})

describe('main’s end of notify', () => {
  const app = 'file:///app/index.html'

  const setUp = () => {
    const listeners = new Map<
      string,
      (sender: string | undefined, values: ReadonlyArray<unknown>) => void
    >()
    const ipc: MainIpc = {
      on: (channel, listener) => listeners.set(channel, listener),
      handle: () => undefined,
    }
    const notified: Array<DesktopNotification> = []
    const actions: MainActions = {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      setTheme: () => undefined,
      notify: notification => notified.push(notification),
      pickFolder: () => Promise.resolve(FolderPick.cases.Cancelled.make({})),
      version: '1.0.0',
      updateStatus: () => UpdateStatus.cases.Unavailable.make({}),
      installLoginService: () =>
        Promise.resolve({ _tag: 'Failed', reason: 'not this test’s' }),
      checkEngine: () =>
        Promise.resolve({ _tag: 'Failed', reason: 'not this test’s' }),
      installEngine: () =>
        Promise.resolve({ _tag: 'Failed', reason: 'not this test’s' }),
      answerSshPrompt: () => undefined,
    }
    registerIpc({ ipc, trusted: url => url === app, actions })
    const send = (sender: string | undefined, ...values: Array<unknown>) =>
      listeners.get(channels.notify)?.(sender, values)
    return { send, notified }
  }

  it('shows what the app’s page sends, decoded again', () => {
    const { send, notified } = setUp()
    send(app, question)
    expect(notified).toEqual([question])
  })

  it('drops one from another page, a frame gone, or that doesn’t decode', () => {
    const { send, notified } = setUp()
    send('https://example.com/', question)
    send(undefined, question)
    send(app, { ...question, title: '' })
    send(app, { ...question, target: { _tag: 'Project' } })
    send(app, question, 'extra')
    send(app)
    expect(notified).toEqual([])
  })
})
