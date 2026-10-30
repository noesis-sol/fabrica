import {
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { Command, Runtime } from 'foldkit'

import { describe, expect, it, test } from '@effect/vitest'
import {
  EngineAddress,
  KnownEngine,
  KnownEnginesAnswer,
  portServer,
  webPortEnd,
} from '@fabrica/client'
import {
  AttentionAnswer,
  AttentionRequest,
  AttentionRpcs,
  EngineHello,
  EngineId,
  EngineRpcs,
  HostLoad,
  ProjectId,
  ProjectRpcs,
  ProjectRunState,
  OpenedTalk,
  ProjectStatus,
  type ProjectStatusItem,
  QuestionAnswer,
  RunId,
  RunRpcs,
  SessionId,
  StreamEpoch,
  TalkId,
  TalkRpcs,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { noAppHost } from '../src/app/host'
import { Message } from '../src/app/message'
import { type Flags, type Model, initialModel } from '../src/app/model'
import { silentNotifier } from '../src/app/notifier'
import { watchedRuns } from '../src/app/notify'
import { program } from '../src/app/program'
import * as RemoteEngines from '../src/app/remote-engines'
import { noSshPromptHost } from '../src/app/ssh-prompts'
import type { AttentionItem } from '../src/app/streams'
import { themeHostOf } from '../src/app/theme-host'
import { update } from '../src/app/update'
import * as Attention from '../src/console/attention'
import * as TalkPanel from '../src/console/talk-panel'

// A known engine's project's requests and streams go through that engine's own connection (spec §9.1,
// §18.1): the whole program runs against two test engines, this machine's on the app's own port and
// one on another host, `build-box`, on the port main relays to it. Under All projects, History and the
// notifications watch the build-box's run through it; with its project scoped, the run view, the
// attention column, the host's load and the run talk ask it, and this machine's engine is asked nothing
// of that project. The notifications keep each engine's open requests apart, and the stats row's load
// is the scoped project's engine's.

const flags: Flags = { platform: 'darwin', release: '0.0.0' }

const home = ProjectId.make('p-home')
const site = ProjectId.make('p-site')
const siteRun = RunId.make('2026-10-30T09:00:00.000+01:00')
const boxEngine = EngineId.make('e-build-box')
const boxAddress = EngineAddress.cases.Ssh.make({ destination: 'me@build-box' })
const epoch = StreamEpoch.make('epoch-1')

const status = (project: ProjectId, name: string, run: ProjectRunState) =>
  new ProjectStatus({
    project,
    name,
    base: 'main',
    setUp: true,
    trusted: false,
    run,
    ready: 0,
  })

/** What an engine was asked: the request or stream, and the project it named. */
interface Asked {
  readonly rpc: string
  readonly project: Option.Option<ProjectId>
}

const load = Schema.decodeUnknownSync(Schema.toCodecJson(HostLoad))({
  sampledAt: 1_793_268_900_000,
  memory: { used: 1_000_000, total: 8_000_000, pressure: 'normal' },
  swapping: false,
  load1: 1.5,
  cores: 8,
  busyCores: 2,
  workers: [],
  mergeCheck: null,
})

const served = EngineRpcs.merge(ProjectRpcs, RunRpcs, AttentionRpcs, TalkRpcs)

const notServed = () => Effect.die('not served')

/**
 * A test engine saying hello as `engine`, sending `projects` as its rows, and keeping in `asked` each
 * project stream and request the app makes of it, the streams left open.
 */
const engineServing = ({
  engine,
  projects,
  asked,
}: {
  readonly engine: EngineId
  readonly projects: ReadonlyArray<ProjectStatus>
  readonly asked: SubscriptionRef.SubscriptionRef<ReadonlyArray<Asked>>
}) => {
  const ask = (rpc: string, project: Option.Option<ProjectId>) =>
    SubscriptionRef.update(asked, all => [...all, { rpc, project }])
  const askedStream = (rpc: string, project: Option.Option<ProjectId>) =>
    Stream.unwrap(Effect.as(ask(rpc, project), Stream.never))
  const rows: ProjectStatusItem = {
    _tag: 'snapshot',
    epoch,
    seq: 0,
    value: projects,
  }
  return served.toLayer({
    'engine.connect': () =>
      Effect.succeed(
        new EngineHello({
          protocol: protocolVersion,
          engine,
          release: '0.0.0',
        }),
      ),
    'engine.version': notServed,
    'engine.status': notServed,
    'engine.settings': notServed,
    'engine.stop': notServed,
    'engine.update': notServed,
    'engine.watchStatus': () => Stream.never,
    'engine.watchLoad': () =>
      Stream.unwrap(
        Effect.as(
          ask('engine.watchLoad', Option.none()),
          Stream.concat(
            Stream.make({
              _tag: 'snapshot' as const,
              epoch,
              seq: 0,
              value: load,
            }),
            Stream.never,
          ),
        ),
      ),
    'projects.add': notServed,
    'projects.folders': notServed,
    'projects.list': notServed,
    'projects.remove': notServed,
    'projects.trust': notServed,
    'projects.settings.get': ({ project }) =>
      Effect.andThen(ask('projects.settings.get', Option.some(project)), () =>
        Effect.die('not served'),
      ),
    'projects.settings.set': notServed,
    'projects.init': notServed,
    'projects.watchStatus': () =>
      Stream.concat(Stream.make(rows), Stream.never),
    'run.start': notServed,
    'run.stop': notServed,
    'run.drain': notServed,
    'run.undrain': notServed,
    'run.status': notServed,
    'run.preflight': notServed,
    'run.watchView': ({ project }) =>
      askedStream('run.watchView', Option.some(project)),
    'run.watchEvents': ({ project }) =>
      askedStream('run.watchEvents', Option.some(project)),
    'attention.list': notServed,
    'attention.answer': ({ answer }) =>
      Effect.andThen(ask('attention.answer', Option.some(answer.project)), () =>
        Effect.die('not served'),
      ),
    'attention.watch': ({ project }) => askedStream('attention.watch', project),
    'talk.open': ({ project }) =>
      Effect.as(
        ask('talk.open', Option.some(project)),
        new OpenedTalk({
          talk: TalkId.make(`t-${engine}`),
          session: SessionId.make(`s-${engine}`),
          model: 'sonnet',
        }),
      ),
    'talk.send': () => ask('talk.send', Option.none()),
    'talk.close': notServed,
    'talk.watchTranscript': () => Stream.never,
  })
}

/** A port pair whose far end an engine serving `handlers` answers; the page's end, closed with the scope. */
const servedPort = <E>(
  handlers: Layer.Layer<Layer.Success<ReturnType<typeof engineServing>>, E>,
) =>
  Effect.gen(function* () {
    const { port1, port2 } = yield* Effect.acquireRelease(
      Effect.sync(() => new MessageChannel()),
      ({ port1, port2 }) =>
        Effect.sync(() => {
          port1.close()
          port2.close()
        }),
    )
    yield* Layer.build(
      RpcServer.layer(served, { disableFatalDefects: true }).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(
          Layer.succeed(
            SocketServer.SocketServer,
            portServer(webPortEnd(port2)),
          ),
        ),
      ),
    )
    return port1
  })

/** Waits until `asked` holds an entry `found` takes. */
const awaitAsked = (
  asked: SubscriptionRef.SubscriptionRef<ReadonlyArray<Asked>>,
  found: (entry: Asked) => boolean,
) =>
  SubscriptionRef.changes(asked).pipe(
    Stream.filter(all => all.some(found)),
    Stream.runHead,
    Effect.asVoid,
  )

const of =
  (rpc: string, project: Option.Option<ProjectId>) =>
  (entry: Asked): boolean =>
    entry.rpc === rpc &&
    Option.match(project, {
      onNone: () => Option.isNone(entry.project),
      onSome: named => Option.contains(entry.project, named),
    })

describe('a known engine’s project', () => {
  it.live(
    'is asked of its own engine, under All projects and once scoped, and not of this machine’s',
    () =>
      Effect.gen(function* () {
        const localAsked = yield* SubscriptionRef.make<ReadonlyArray<Asked>>([])
        const boxAsked = yield* SubscriptionRef.make<ReadonlyArray<Asked>>([])
        const localPort = yield* servedPort(
          engineServing({
            engine: EngineId.make('e-local'),
            projects: [
              status(home, 'home', ProjectRunState.cases.idle.make({})),
            ],
            asked: localAsked,
          }),
        )
        const boxPort = yield* servedPort(
          engineServing({
            engine: boxEngine,
            projects: [
              status(
                site,
                'site',
                ProjectRunState.cases.running.make({
                  run: siteRun,
                  overnight: false,
                }),
              ),
            ],
            asked: boxAsked,
          }),
        )

        // The test's tick stands for the user choosing the build-box's project in the sidebar.
        const ticks = yield* Queue.unbounded<DateTime.Zoned>()
        const crashed = yield* Deferred.make<Error>()
        const {
          Flags: _flags,
          init: _init,
          ...app
        } = program({
          enginePort: Effect.succeed(localPort),
          nextFrame: Effect.void,
          keys: Stream.never,
          ticks: Stream.fromQueue(ticks),
          replacedEnginePorts: Stream.never,
          notifier: silentNotifier,
          host: {
            ...noAppHost,
            knownEngines: Option.some(
              Effect.succeed(
                KnownEnginesAnswer.cases.Read.make({
                  engines: [
                    KnownEngine.make({
                      name: 'build-box',
                      address: boxAddress,
                      engine: boxEngine,
                      protocol: protocolVersion,
                    }),
                  ],
                }),
              ),
            ),
            enginePort: Option.some(() => Effect.succeed(boxPort)),
          },
          sshPrompts: noSshPromptHost,
          themeHost: themeHostOf(window),
        })
        const container = document.createElement('div')
        container.id = 'root'
        document.body.append(container)
        const handle = Runtime.embed(
          Runtime.makeApplication({
            ...app,
            init: () => ({
              model: initialModel(flags),
              commands: [RemoteEngines.LoadKnownEngines()],
            }),
            update: (model, message) => {
              const next = update(model, message)
              // The run talk opened on the build-box's project: the user writes to it.
              if (
                message._tag === 'GotTalkPanelMessage' &&
                message.message._tag === 'OpenedRunTalk' &&
                message.message.project === site
              ) {
                return {
                  model: next.model,
                  commands: [
                    ...(next.commands ?? []),
                    Command.mapMessage(
                      TalkPanel.SendToTalk({
                        talk: message.message.opened.talk,
                        text: 'Hold the merges',
                      }),
                      sent => Message.GotTalkPanelMessage({ message: sent }),
                    ),
                  ],
                }
              }
              if (message._tag !== 'Ticked' || Option.isSome(model.scope)) {
                return next
              }
              // The build-box's project scoped, the user answers a question of it, and its questions
              // setting is read.
              const scoped = update(
                next.model,
                Message.SelectedScope({ project: Option.some(site) }),
              )
              return {
                model: scoped.model,
                commands: [
                  ...(next.commands ?? []),
                  ...(scoped.commands ?? []),
                  Command.mapMessage(
                    Attention.Answer({
                      key: 'question',
                      answer: AttentionAnswer.cases.question.make({
                        project: site,
                        ticket: TicketId.make('si-1'),
                        answer: QuestionAnswer.cases.option.make({ index: 0 }),
                      }),
                    }),
                    answered =>
                      Message.GotAttentionMessage({ message: answered }),
                  ),
                  Command.mapMessage(
                    TalkPanel.LoadQuestionsSetting({ project: site }),
                    read => Message.GotTalkPanelMessage({ message: read }),
                  ),
                ],
              }
            },
            container,
            crash: {
              report: ({ error }) => {
                Deferred.doneUnsafe(crashed, Effect.succeed(error))
              },
            },
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(handle.dispose))

        /** Waits for `asked` to hold what `found` takes, failing with the crash where the app crashes first. */
        const awaiting = (
          asked: SubscriptionRef.SubscriptionRef<ReadonlyArray<Asked>>,
          found: (entry: Asked) => boolean,
        ) =>
          Effect.raceFirst(
            awaitAsked(asked, found),
            Effect.flatMap(Deferred.await(crashed), error =>
              Effect.fail(error),
            ),
          )

        // Under All projects: the build-box's run going is watched through the build-box, for History
        // and the notifications, and each engine's attention requests are read for those to notify.
        yield* awaiting(boxAsked, of('run.watchEvents', Option.some(site)))
        yield* awaiting(boxAsked, of('attention.watch', Option.none()))
        yield* awaiting(localAsked, of('attention.watch', Option.none()))
        // The load is this machine's engine's while no project is scoped.
        yield* awaiting(localAsked, of('engine.watchLoad', Option.none()))
        expect(
          (yield* SubscriptionRef.get(boxAsked)).filter(
            of('engine.watchLoad', Option.none()),
          ),
        ).toEqual([])

        // The build-box's project scoped: its run view, its attention, its host's load and its run talk
        // are the build-box's.
        yield* Queue.offer(
          ticks,
          DateTime.makeZonedUnsafe(0, { timeZone: 'UTC' }),
        )
        yield* awaiting(boxAsked, of('run.watchView', Option.some(site)))
        yield* awaiting(boxAsked, of('attention.watch', Option.some(site)))
        yield* awaiting(boxAsked, of('engine.watchLoad', Option.none()))
        yield* awaiting(boxAsked, of('talk.open', Option.some(site)))
        // Its Commands too: the answer, the setting read, and what is sent to its run talk.
        yield* awaiting(boxAsked, of('attention.answer', Option.some(site)))
        yield* awaiting(
          boxAsked,
          of('projects.settings.get', Option.some(site)),
        )
        yield* awaiting(boxAsked, of('talk.send', Option.none()))

        expect(
          (yield* SubscriptionRef.get(localAsked)).filter(
            entry =>
              Option.contains(entry.project, site) || entry.rpc === 'talk.send',
          ),
        ).toEqual([])
        expect(yield* Deferred.isDone(crashed)).toBe(false)
      }).pipe(Effect.scoped),
  )
})

// The Model's side: which engine each run, open request and load sample is of.

const box = 'build-box'

const connected: Model = {
  ...initialModel(flags),
  connection: Connection.Up({
    engine: EngineId.make('e-local'),
    release: '0.0.0',
    protocol: protocolVersion,
  }),
  remotes: RemoteEngines.connected(
    RemoteEngines.added(RemoteEngines.init(), {
      name: box,
      address: boxAddress,
    }),
    {
      name: box,
      hello: Connection.Up({
        engine: boxEngine,
        release: '0.0.0',
        protocol: protocolVersion,
      }),
    },
  ).model,
}

const rowsOf = (
  engine: EngineId,
  name: string,
  projects: ReadonlyArray<ProjectStatus>,
) =>
  Message.ReceivedProjects({
    engine,
    name,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: projects }],
  })

const running = ProjectRunState.cases.running.make({
  run: siteRun,
  overnight: false,
})

/** Both engines' rows: this machine's `home`, and the build-box's `site`, both running a run of one ID. */
const withRows = [
  rowsOf(EngineId.make('e-local'), localEngineName, [
    status(home, 'home', running),
  ]),
  rowsOf(boxEngine, box, [status(site, 'site', running)]),
].reduce((model, message) => update(model, message).model, connected)

const question = (project: ProjectId, ticket: string) =>
  AttentionRequest.cases.question.make({
    project,
    ticket: TicketId.make(ticket),
    title: `Question ${ticket}`,
    description: Option.none(),
    choices: Option.none(),
    consequential: false,
    maintainerOnly: false,
    blocks: [],
    askedFrom: Option.none(),
    openedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 8)),
  })

const snapshot = (
  ...requests: ReadonlyArray<AttentionRequest>
): readonly [typeof AttentionItem.Type] => [
  { _tag: 'snapshot', epoch, seq: 0, value: requests },
]

const arrived = (
  ...requests: ReadonlyArray<AttentionRequest>
): readonly [typeof AttentionItem.Type] => [
  { _tag: 'patch', seq: 1, value: { upsert: requests, remove: [] } },
]

const told = (model: Model, message: Message) =>
  (update(model, message).commands ?? []).map(command => command.name)

describe('the notifications, over every engine', () => {
  test('watch each engine’s runs going, a run of one ID on two engines twice', () => {
    expect(watchedRuns(withRows.notify)).toEqual([
      { engine: localEngineName, project: home, run: siteRun },
      { engine: box, project: site, run: siteRun },
    ])
  })

  test('keep each engine’s open requests apart: one engine’s first snapshot tells nothing, nor changes another’s', () => {
    const localQuestion = question(home, 'fa-1')
    const steps = [
      Message.ReceivedAttentionToNotify({
        engine: localEngineName,
        items: snapshot(),
      }),
      Message.ReceivedAttentionToNotify({
        engine: localEngineName,
        items: arrived(localQuestion),
      }),
    ]
    const asked = steps.reduce(
      (model, message) => update(model, message).model,
      withRows,
    )
    // The build-box's first snapshot tells nothing of what is open there.
    const boxSnapshot = Message.ReceivedAttentionToNotify({
      engine: box,
      items: snapshot(question(site, 'si-1')),
    })
    expect(told(asked, boxSnapshot)).toEqual([])
    const both = update(asked, boxSnapshot).model
    // This machine's question is still open there: its next snapshot tells it no more.
    expect(
      told(
        both,
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: snapshot(localQuestion),
        }),
      ),
    ).toEqual([])
    // A question arriving on the build-box tells.
    expect(
      told(
        both,
        Message.ReceivedAttentionToNotify({
          engine: box,
          items: arrived(question(site, 'si-2')),
        }),
      ),
    ).toEqual(['ShowNotification'])
  })

  test('read a run’s events as its engine’s: another engine’s run of the same ID is left as it is', () => {
    const ended = update(
      withRows,
      Message.EndedRunEvents({ engine: box, project: site, run: siteRun }),
    ).model
    expect(watchedRuns(ended.notify)).toEqual([
      { engine: localEngineName, project: home, run: siteRun },
    ])
  })
})

describe('the stats row’s load', () => {
  const loadItems = [
    { _tag: 'snapshot' as const, epoch, seq: 0, value: load },
  ] as const

  test('is the scoped project’s engine’s: another engine’s sample is left out', () => {
    const scoped = update(
      withRows,
      Message.SelectedScope({ project: Option.some(site) }),
    ).model
    expect(
      update(
        scoped,
        Message.ReceivedLoad({ engine: localEngineName, items: loadItems }),
      ).model.load,
    ).toEqual(Option.none())
    expect(
      update(scoped, Message.ReceivedLoad({ engine: box, items: loadItems }))
        .model.load,
    ).toEqual(Option.some(load))
  })

  test('is read afresh when the scope moves to another engine’s project, kept within one engine', () => {
    const loaded = update(
      withRows,
      Message.ReceivedLoad({ engine: localEngineName, items: loadItems }),
    ).model
    expect(
      update(loaded, Message.SelectedScope({ project: Option.some(home) }))
        .model.load,
    ).toEqual(Option.some(load))
    expect(
      update(loaded, Message.SelectedScope({ project: Option.some(site) }))
        .model.load,
    ).toEqual(Option.none())
  })
})
