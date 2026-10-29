import { Effect, Layer, Option, Queue, Schema, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import {
  Subscription,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  text,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import { portServer, webPortEnd } from '@fabrica/client'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  ProjectId,
  RunHeader,
  RunRpcs,
  RunView,
  RunViewPatch,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, connect } from '../src/app/connection'
import { perFrame } from '../src/app/frame'
import {
  type KeyCommand,
  chordLabel,
  commandsFor,
  keyHelp,
  openPalette,
} from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Flags, type Model, Overlay, initialModel } from '../src/app/model'
import { clientName } from '../src/app/program'
import { Screen } from '../src/app/screen'
import { RunViewItem } from '../src/app/streams'
import { runViewMessages } from '../src/app/subscriptions'
import { WaitToReconnect, update } from '../src/app/update'
import { layout, view } from '../src/app/view'
import * as Settings from '../src/screens/settings'

// The UI root (spec §18.1, §18.3, §18.5, Appendix A.1): routing between the screens, the keys drawn
// from each screen's command list into the key help, the engine's frames decoded into the Model, and
// the console's layout at the handoff's 1280 × 800 reference window.

const flags: Flags = { platform: 'darwin', release: '0.0.0' }

const start: Model = initialModel(flags)

const project = ProjectId.make('p-1')

const connected: Model = {
  ...start,
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
}

const key = (pressed: string, mod = false) =>
  Message.PressedKey({ key: pressed, mod, alt: false, inField: false })

describe('routing', () => {
  test('the app opens on the console, connecting', () => {
    expect(start.screen).toEqual(Screen.Console())
    expect(start.connection).toEqual(Connection.Connecting())
    expect(start.overlay).toEqual(Overlay.Closed())
  })

  test('a requested screen is shown, and Escape goes back to the console', () => {
    story(
      update,
      given(start),
      message(Message.RequestedScreen({ screen: Screen.Backlog() })),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Backlog())
      }),
      message(key('Escape')),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
      }),
    )
  })

  test('a worker view is routed to by its ticket', () => {
    const ticket = TicketId.make('fa-a1b2')
    story(
      update,
      given(start),
      message(Message.RequestedScreen({ screen: Screen.Worker({ ticket }) })),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Worker({ ticket }))
      }),
    )
  })

  test('the command list binds each screen to its key', () => {
    story(
      update,
      given(start),
      message(key('3', true)),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Backlog())
      }),
      message(key(',', true)),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Settings())
      }),
      // The Settings screen asks the engine for its settings as it opens.
      Command.resolve(
        Settings.LoadEngineSettings,
        Settings.Message.FailedLoadEngineSettings({
          reason: 'not connected to the engine',
        }),
      ),
      message(key('1', true)),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
      }),
    )
  })

  test('plain keys typed in a text field are typing, not commands', () => {
    story(
      update,
      given(start),
      message(
        Message.PressedKey({ key: '?', mod: false, alt: false, inField: true }),
      ),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
      message(
        Message.PressedKey({ key: 'k', mod: true, alt: false, inField: true }),
      ),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Palette())
      }),
    )
  })

  test("an overlay's Escape closes it before the screen's goes back", () => {
    story(
      update,
      given({ ...start, screen: Screen.Review() }),
      message(key('?')),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.KeyHelp())
      }),
      message(key('Escape')),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Closed())
        expect(shown.screen).toEqual(Screen.Review())
      }),
    )
  })

  test('navigating from the palette closes it', () => {
    story(
      update,
      given({ ...start, overlay: Overlay.Palette() }),
      message(Message.RequestedScreen({ screen: Screen.Insights() })),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Insights())
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
    )
  })
})

describe('the connection', () => {
  test('a failed attempt is tried again after a pause, as a new attempt', () => {
    story(
      update,
      given(start),
      message(Message.FailedToConnect({ reason: 'no port' })),
      model(shown => {
        expect(shown.connection).toEqual(
          Connection.Failed({ reason: 'no port' }),
        )
      }),
      Command.resolve(WaitToReconnect, Message.WaitedToReconnect()),
      model(shown => {
        expect(shown.attempt).toBe(2)
        expect(shown.connection).toEqual(Connection.Connecting())
      }),
    )
  })

  test('a refused hello is not tried again', () => {
    story(
      update,
      given(start),
      message(
        Message.RefusedByEngine({ client: 1, engine: 3, update: 'client' }),
      ),
      Command.expectNone(),
      model(shown => {
        expect(Connection.guards.Refused(shown.connection)).toBe(true)
      }),
    )
  })
})

const allScreens: ReadonlyArray<Screen> = [
  Screen.Console(),
  Screen.Worker({ ticket: TicketId.make('fa-a1b2') }),
  Screen.Talks(),
  Screen.Backlog(),
  Screen.Review(),
  Screen.Insights(),
  Screen.Engines(),
  Screen.Settings(),
]

const boundKeys = (commands: ReadonlyArray<KeyCommand>) =>
  commands.flatMap(command =>
    Option.match(command.chord, {
      onNone: () => [],
      onSome: chord => [chordLabel(chord, flags.platform)],
    }),
  )

describe('the key help', () => {
  test('every key a screen binds is in its help, each once', () => {
    for (const screen of allScreens) {
      for (const overlayOpen of [false, true]) {
        const commands = commandsFor({ screen, overlayOpen })
        const help = boundKeys(keyHelp(commands))
        expect(new Set(help)).toEqual(new Set(boundKeys(commands)))
        expect(help).toHaveLength(new Set(help).size)
      }
    }
  })

  test('a key bound from the command list appears in the help the ? key opens', () => {
    scene(
      { update, view },
      givenScene(connected),
      expectScene(role('dialog', { name: 'Keys' })).toBeAbsent(),
      Subscription.emit(key('?')),
      expectScene(role('dialog', { name: 'Keys' })).toExist(),
      expectScene(
        within(role('dialog', { name: 'Keys' }), text('⌘K')),
      ).toExist(),
      expectScene(
        within(
          role('dialog', { name: 'Keys' }),
          text('Open the command palette'),
        ),
      ).toExist(),
      expectScene(
        within(role('dialog', { name: 'Keys' }), text('Go to Backlog')),
      ).toExist(),
      Subscription.emit(key('Escape')),
      expectScene(role('dialog', { name: 'Keys' })).toBeAbsent(),
    )
  })

  test("the title bar's search field hints at the palette's key, and opens it", () => {
    const label = Option.getOrThrow(
      Option.map(openPalette.chord, chord => chordLabel(chord, 'linux')),
    )
    scene(
      { update, view },
      givenScene({ ...connected, platform: 'linux' }),
      expectScene(
        role('button', { name: `Search tickets and sessions ${label}` }),
      ).toExist(),
      expectScene(role('dialog', { name: 'Command palette' })).toBeAbsent(),
      click(role('button', { name: `Search tickets and sessions ${label}` })),
      expectScene(role('dialog', { name: 'Command palette' })).toExist(),
      expectScene(
        within(
          role('dialog', { name: 'Command palette' }),
          role('button', { name: /^Go to Backlog/u }),
        ),
      ).toExist(),
      expectScene(
        within(role('dialog', { name: 'Command palette' }), text('Ctrl+3')),
      ).toExist(),
    )
    expect(label).toBe('Ctrl+K')
  })
})

describe('the layout', () => {
  test("the console's frame at the 1280 × 800 reference window", () => {
    scene(
      { update, view },
      givenScene(connected),
      expectScene(role('banner', { name: 'Title bar' })).toHaveStyle(
        'height',
        '38px',
      ),
      expectScene(selector('[data-layout="body"]')).toHaveStyle(
        'gridTemplateColumns',
        '260px minmax(0,1fr)',
      ),
      expectScene(role('navigation', { name: 'Projects' })).toExist(),
      expectScene(role('main')).toHaveStyle('padding', '20px 24px'),
      expectScene(role('region', { name: 'Ticket stats' })).toExist(),
      expectScene(selector('[data-layout="talk-row"]')).toHaveStyle(
        'gridTemplateColumns',
        'minmax(0,1fr) 320px',
      ),
      expectScene(selector('[data-layout="talk-row"]')).toHaveStyle(
        'height',
        '156px',
      ),
      expectScene(role('region', { name: 'Run talk' })).toExist(),
      expectScene(role('region', { name: 'History' })).toExist(),
      expectScene(selector('[data-layout="ticket-columns"]')).toHaveStyle(
        'gridTemplateColumns',
        'minmax(0,1fr) minmax(0,1fr)',
      ),
      expectScene(role('region', { name: 'In progress' })).toExist(),
      expectScene(role('region', { name: 'Up next' })).toExist(),
      expectScene(role('status')).toBeAbsent(),
    )
    expect(layout).toEqual({
      titleBarHeight: '38px',
      sidebarWidth: '260px',
      mainPadding: '20px 24px',
      talkRowHeight: '156px',
      historyWidth: '320px',
    })
  })

  test('a screen other than the console replaces the main column, with its hints', () => {
    scene(
      { update, view },
      givenScene({ ...connected, screen: Screen.Insights() }),
      expectScene(role('region', { name: 'Ticket stats' })).toBeAbsent(),
      expectScene(role('heading', { name: 'Insights', level: 1 })).toExist(),
      expectScene(role('button', { name: /Back to the console/u })).toExist(),
    )
  })

  test('while connecting, the main column says so', () => {
    scene(
      { update, view },
      givenScene(start),
      expectScene(role('status')).toHaveText('Connecting to the engine…'),
    )
  })
})

describe('updates once per animation frame', () => {
  it.live('hands on what arrived before the frame as one batch', () =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<number>()
      const frames = yield* Queue.unbounded<void>()
      const batches = yield* Queue.unbounded<ReadonlyArray<number>>()
      yield* Stream.fromQueue(input).pipe(
        perFrame(Queue.take(frames)),
        Stream.runForEach(batch => Queue.offer(batches, batch)),
        Effect.forkScoped,
      )
      yield* Queue.offerAll(input, [1, 2, 3])
      yield* Queue.offer(frames, undefined)
      expect(yield* Queue.take(batches)).toEqual([1, 2, 3])
      yield* Queue.offer(input, 4)
      yield* Queue.offer(frames, undefined)
      expect(yield* Queue.take(batches)).toEqual([4])
    }),
  )
})

// A test engine on the far end of a MessageChannel, as the connection process relays it: it says
// hello and sends the project's run view, a snapshot then a patch, as NDJSON frames.

const at = 1_793_268_900_000

const viewJson = {
  header: {
    run: 'r-1',
    project,
    engine: 'e-1',
    mode: { _tag: 'tickets' },
    state: 'running',
    startedAt: at,
    offline: false,
    autoAnswer: false,
  },
  totals: {
    live: 1,
    slots: 4,
    counts: {
      in_queue: 3,
      working: 1,
      waiting_to_merge: 0,
      needs_you: 0,
      set_aside: 0,
      carried_over: 0,
      done: 5,
    },
    tokens: { input: 10, output: 20, cache_write: 30, cache_read: 40 },
    costUsd: null,
  },
  tickets: [],
  workers: [],
  queue: { merging: null, train: null, waiting: [] },
  holds: [],
  banners: [],
  attention: [],
  load: null,
  steps: [],
}

const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))(viewJson)
const patch = Schema.decodeUnknownSync(Schema.toCodecJson(RunViewPatch))({
  totals: { ...viewJson.totals, live: 2 },
})

const items: ReadonlyArray<typeof RunViewItem.Type> = [
  {
    _tag: 'snapshot',
    epoch: StreamEpoch.make('epoch-1'),
    seq: 0,
    value: snapshot,
  },
  { _tag: 'patch', seq: 1, value: patch },
]

const served = EngineRpcs.merge(RunRpcs)

const notServed = () => Effect.die('not served')

const handlers = served.toLayer({
  'engine.connect': () =>
    Effect.succeed(
      new EngineHello({
        protocol: protocolVersion,
        engine: EngineId.make('e-1'),
        release: '0.1.0',
      }),
    ),
  'engine.version': notServed,
  'engine.status': notServed,
  'engine.settings': notServed,
  'engine.stop': notServed,
  'engine.update': notServed,
  'engine.watchStatus': () => Stream.die('not served'),
  'engine.watchLoad': () => Stream.die('not served'),
  'run.start': notServed,
  'run.stop': notServed,
  'run.drain': notServed,
  'run.undrain': notServed,
  'run.status': notServed,
  'run.preflight': notServed,
  'run.watchView': () => Stream.fromIterable(items),
  'run.watchEvents': () => Stream.die('not served'),
})

describe('frames decoded into the Model', () => {
  it.live(
    "the engine's run view, relayed over the port, becomes the Model's",
    () =>
      Effect.gen(function* () {
        const channel = new MessageChannel()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            channel.port1.close()
            channel.port2.close()
          }),
        )
        const server = portServer(webPortEnd(channel.port2))
        yield* Layer.build(
          RpcServer.layer(served).pipe(
            Layer.provide(handlers),
            Layer.provide(RpcServer.layerProtocolSocketServer),
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
          ),
        )

        const session = yield* connect({
          enginePort: Effect.succeed(channel.port1),
          client: { name: clientName, kind: 'app', release: '0.0.0' },
        })
        expect(session.hello.engine).toBe('e-1')

        const messages = yield* Stream.runCollect(
          runViewMessages(session.client, project, Effect.void),
        )
        const after = messages.reduce(
          (shown, received) => update(shown, received).model,
          connected,
        )
        const runView = Option.getOrThrow(after.runView)
        expect(runView.header).toBeInstanceOf(RunHeader)
        expect(runView.header.project).toBe(project)
        expect(runView.totals.live).toBe(2)
        expect(runView.totals.counts.done).toBe(5)
      }),
  )
})
