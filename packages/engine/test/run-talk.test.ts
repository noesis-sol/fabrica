import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Actor,
  Answered,
  type AttentionAnswer,
  AttentionRequest,
  EngineHost,
  FabricaRpcs,
  PermissionId,
  ProjectId,
  ProjectSource,
  type RunEvent,
  type RunId,
  type RunView,
  SessionId,
  TalkId,
  TicketId,
  type ToolRefusal,
  applyRunViewPatch,
  toolJsonSchema,
} from '@fabrica/contracts'

import type { PiEvent } from '../src/agent'
import type { AttentionRequestsShape } from '../src/attention'
import { pathsIn, startEngine } from '../src/engine'
import type { ProjectsShape } from '../src/projects'
import type { RunsShape } from '../src/run/registry'
import { type EventDraft, readEvents } from '../src/runlog'
import {
  type TalkAgentStart,
  TalkAgents,
  TalkModes,
  type TalkToolContext,
  registeredModes,
  runInstructions,
  runMode,
} from '../src/talks'
import {
  WorkGraph,
  type WorkGraphShape,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// The run talk (spec §15.4, H44), on a test engine whose runs go on the scripted agent and whose talk
// is a scripted Pi session: each message the maintainer sends plays the calls the test gives it,
// through the engine's side of a call, as a talk's agent hands a call over. A command does what the
// engine's command does and leaves a record of the event stream with actor `run_talk`; a stop, a close
// and a cancel are refused until the maintainer has been asked and has answered; the talk has no tool
// but its own, and none of them is a shell.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 4,
})

type Call = {
  readonly tool: string
  readonly input: unknown
  /** Holds the turn here until it is done, so that the maintainer can send something into it. */
  readonly after?: Deferred.Deferred<void>
}

/** What the scripted sessions were started with, the calls the next message plays, and their answers. */
interface Script {
  readonly started: Ref.Ref<ReadonlyArray<TalkAgentStart>>
  readonly calls: Queue.Queue<Call>
  readonly answers: Queue.Queue<Exit.Exit<unknown, ToolRefusal>>
}

/** Talks' agents whose every message plays the calls waiting, one after another, then settles. */
const scriptedAgents = (script: Script) =>
  Layer.succeed(TalkAgents)({
    start: options =>
      Effect.gen(function* () {
        yield* Ref.update(script.started, all => [...all, options])
        const events = yield* PubSub.unbounded<PiEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(events))
        const scope = yield* Effect.scope
        const play = () =>
          Effect.gen(function* () {
            const calls = yield* Queue.clear(script.calls)
            yield* Effect.forEach(
              calls,
              ({ after, ...call }) =>
                Effect.flatMap(Effect.exit(options.call(call)), answer =>
                  Queue.offer(script.answers, answer),
                ).pipe(
                  Effect.andThen(
                    after === undefined ? Effect.void : Deferred.await(after),
                  ),
                ),
              { discard: true },
            )
            yield* PubSub.publish(events, {
              type: 'agent_settled',
              aborted: false,
            })
          })
        return {
          session: {
            id: SessionId.make(`s-${options.talk}`),
            file: Option.none(),
          },
          events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          prompt: play,
          // Into the running turn, which goes on; a message that finds the last turn settling plays too.
          steer: () => Effect.asVoid(Effect.forkIn(play(), scope)),
        }
      }),
  })

/** A test engine with one project, its run talk open on a scripted session. */
const newEngine = Effect.gen(function* () {
  const data = yield* Effect.promise(() =>
    mkdtemp(NodePath.join(places.root, 'e')),
  )
  const paths = pathsIn({ data, socketFolder: data })
  const script: Script = {
    started: yield* Ref.make<ReadonlyArray<TalkAgentStart>>([]),
    calls: yield* Queue.unbounded<Call>(),
    answers: yield* Queue.unbounded<Exit.Exit<unknown, ToolRefusal>>(),
  }
  yield* startEngine({
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    runs: scriptedHosting(places, paths.data),
    talks: Layer.mergeAll(
      Layer.effect(
        TalkModes,
        Effect.map(TalkModes, modes => ({
          ...modes,
          answer: {
            keep: false,
            instructions: 'Answer them.',
            tools: [],
            opening: () => Effect.succeedNone,
          },
        })),
      ).pipe(Layer.provide(registeredModes)),
      scriptedAgents(script),
    ),
  })
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([
        NodeSocket.layerNet({ path: paths.socket }),
        RpcSerialization.layerNdjson,
      ]),
    ),
  )
  const client = yield* RpcClient.make(FabricaRpcs).pipe(
    Effect.provide(protocol),
  )
  const checkout = makeCheckout(places, {
    ...scriptedSettings,
    model: 'anthropic/claude-opus-5-5',
  })
  const { id: project } = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({ path: checkout }),
    name: Option.some('work'),
  })
  const { talk } = yield* client['talk.open']({
    project,
    context: { _tag: 'run' },
    model: Option.none(),
  })
  /** The maintainer sends `text`, and the session plays `calls`: their answers, in turn. */
  const say = Effect.fn(function* (
    text: string,
    calls: ReadonlyArray<Call> = [],
  ) {
    yield* Queue.offerAll(script.calls, calls)
    yield* client['talk.send']({ talk, text })
    return yield* Effect.forEach(calls, () => Queue.take(script.answers))
  })
  /** The maintainer sends `text`, and the session makes the one call: its answer. */
  const callOn = Effect.fn(function* (
    text: string,
    tool: string,
    input: unknown = {},
  ) {
    const [answer] = yield* say(text, [{ tool, input }])
    return answer ?? expect.fail('no answer')
  })
  /**
   * The maintainer says yes to `tool` asked: a yes that finds the last turn still settling is steered
   * into it, so it answers nothing and the call asks again, for the next yes to answer.
   */
  const yesTo = Effect.fn(function* (tool: string, input: unknown = {}) {
    for (let left = 20; left > 0; left -= 1) {
      const answer = yield* callOn('yes', tool, input)
      if (
        !Exit.isFailure(answer) ||
        Option.getOrUndefined(Cause.findErrorOption(answer.cause))?._tag !==
          'confirm_first'
      )
        return answer
    }
    return expect.fail('no yes opened a turn')
  })
  return { client, project, checkout, script, talk, say, callOn, yesTo }
})

type Engine = Effect.Success<typeof newEngine>

/** What the call answered, where it was answered. */
const answerOf = (exit: Exit.Exit<unknown, ToolRefusal>): unknown =>
  Exit.isSuccess(exit) ? exit.value : expect.fail(Cause.pretty(exit.cause))

/** Why the call was refused, where it was. */
const refusalOf = (exit: Exit.Exit<unknown, ToolRefusal>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it was answered')

/** A task whose stub does `script`, filed through the engine. */
const file = ({ client, project }: Engine, title: string, script = 'hang') =>
  Effect.map(
    client['tickets.create']({
      project,
      ticket: {
        type: 'task',
        title,
        description: Option.some(`stub: ${script}`),
        design: Option.none(),
        acceptance: Option.none(),
        priority: Option.none(),
        labels: Option.none(),
        parent: Option.none(),
        metadata: Option.none(),
        model: Option.none(),
      },
    }),
    ({ id }) => id,
  )

/** The project's event stream as it is written, in its checkout. */
const written = ({ checkout }: Engine) =>
  Effect.map(
    readEvents({ root: checkout, run: Option.none() }),
    ({ events }) => events,
  )

const actions = (events: ReadonlyArray<RunEvent>) =>
  events.filter(event => event.kind === 'talk_action')

/** Waits for the run going to have its worker there: once its view shows it. */
const dispatched = ({ client, project }: Engine) =>
  client['run.watchView']({ project, resume: Option.none() }).pipe(
    Stream.mapAccum(Option.none<RunView>, (kept, item) => {
      const view =
        item._tag === 'snapshot'
          ? item.value
          : Option.match(kept, {
              onNone: () => expect.fail('a patch before the snapshot'),
              onSome: before => applyRunViewPatch(before, item.value),
            })
      return [Option.some(view), [view]]
    }),
    Stream.takeUntil(view => view.workers.length === 1),
    Stream.runDrain,
  )

/** The run going's ID. */
const goingRun = ({ client, project }: Engine) =>
  Effect.map(client['run.status']({ project }), status =>
    status._tag === 'going' ? status.header.run : expect.fail('no run going'),
  )

/** Waits for `run` to end, whether it has or not. */
const ended = ({ client, project }: Engine, run: RunId) =>
  client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(Stream.runDrain)

/** A real run on the scripted agent starts a Pi stub's process, slow on a machine under load. */
const runTimeout = 60_000

describe('the run talk’s tools', () => {
  it.live(
    'are its own: no shell, no git, no code edits, not even Pi’s readers',
    () =>
      Effect.gen(function* () {
        const { script } = yield* newEngine
        const [started] = yield* Ref.get(script.started)
        const names = started?.tools.map(({ name }) => name)
        expect(names).toStrictEqual([
          'run_view',
          'run_events',
          'ticket_show',
          'ticket_why',
          'tickets_ready',
          'worker_transcript',
          'run_log',
          'open_requests',
          'message_worker',
          'release_worker',
          'start_run',
          'drain_run',
          'undrain_run',
          'stop_run',
          'hold_ticket',
          'file_ticket',
          'update_ticket',
          'defer_ticket',
          'label_ticket',
          'close_ticket',
          'cancel_ticket',
          'answer_question',
          'answer_permission',
          'open_answer_talk',
        ])
        for (const none of ['bash', 'shell', 'git', 'edit', 'write', 'read'])
          expect(names).not.toContain(none)
        expect(started?.readsCode).toBe(false)
        expect(started?.instructions).toBe(runInstructions)
        // Each is shown to the model with its arguments' JSON Schema.
        for (const tool of started?.tools ?? [])
          expect(toolJsonSchema(tool).parameters).toMatchObject({
            type: 'object',
          })
      }).pipe(Effect.scoped),
  )

  it.live('are refused a tool it hasn’t: the shell', () =>
    Effect.gen(function* () {
      const { callOn } = yield* newEngine
      expect(
        refusalOf(yield* callOn('run ls', 'bash', { command: 'ls' })),
      ).toMatchObject({
        _tag: 'invalid',
        issue: 'the run talk has no tool bash',
      })
    }).pipe(Effect.scoped),
  )
})

describe('the kept run talk', () => {
  it.live('is one per project, waiting for the maintainer', () =>
    Effect.gen(function* () {
      const { client, project, talk, script } = yield* newEngine
      const again = yield* client['talk.open']({
        project,
        context: { _tag: 'run' },
        model: Option.none(),
      })
      expect(again.talk).toBe(talk)
      expect(yield* Ref.get(script.started)).toHaveLength(1)
      const [started] = yield* Ref.get(script.started)
      expect(NodePath.basename(started?.sessions ?? '')).toBe('run')
    }).pipe(Effect.scoped),
  )
})

describe('a run driven from the talk', () => {
  it.live(
    'starts, drains and undrains through its tools, each an event with actor run_talk',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, callOn } = engine
        const ticket = yield* file(engine, 'Never done')
        const started = answerOf(yield* callOn('go on', 'start_run'))
        expect(started).toMatchObject({
          text: expect.stringContaining('Run talk started the run'),
        })
        yield* dispatched(engine)

        expect(
          answerOf(yield* callOn('no new tickets', 'drain_run')),
        ).toStrictEqual({ text: 'Run talk drained the run' })
        const draining = yield* client['run.status']({ project })
        expect(draining).toMatchObject({
          _tag: 'going',
          header: { state: 'draining' },
        })
        const [feed] = yield* client['run.watchEvents']({
          project,
          run: Option.none(),
          resume: Option.none(),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(actions(feed?.value ?? [])).toMatchObject([
          { actor: 'run_talk', tool: 'start_run' },
          {
            kind: 'talk_action',
            actor: 'run_talk',
            tool: 'drain_run',
            text: 'Run talk drained the run',
          },
        ])

        yield* callOn('take it back', 'undrain_run')
        expect(yield* client['run.status']({ project })).toMatchObject({
          header: { state: 'running' },
        })

        // The worker reached through the talk.
        expect(
          answerOf(
            yield* callOn('tell it', 'message_worker', {
              ticket,
              text: 'look at the log',
            }),
          ),
        ).toStrictEqual({
          text: `Run talk messaged the worker of ${ticket}`,
          also: 'Unless it settles its ticket, the worker now waits for its release: release_worker hands it back to the engine.',
        })
        expect(
          answerOf(yield* callOn('let it go on', 'release_worker', { ticket })),
        ).toStrictEqual({
          text: `Run talk released the worker of ${ticket}`,
        })
        expect(
          refusalOf(yield* callOn('again', 'release_worker', { ticket })),
        ).toMatchObject({ issue: `the worker of ${ticket} isn't steered` })
        expect(
          answerOf(yield* callOn('see it', 'worker_transcript', { ticket })),
        ).toBeInstanceOf(Array)

        // What it reads of the run.
        expect(answerOf(yield* callOn('how', 'run_view'))).toMatchObject({
          _tag: 'going',
          view: { header: { state: 'running' } },
        })
        expect(
          answerOf(yield* callOn('what happened', 'run_events', { last: 1 })),
        ).toHaveLength(1)
        expect(
          answerOf(yield* callOn('what happened', 'run_events', { last: 500 })),
        ).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({ tool: 'undrain_run' }),
            expect.objectContaining({ tool: 'message_worker', ticket }),
            expect.objectContaining({ tool: 'release_worker', ticket }),
          ]),
        )
        expect(
          answerOf(yield* callOn('the log', 'run_log', { last: 500 })),
        ).toStrictEqual(
          expect.arrayContaining([
            expect.stringContaining(
              `Run talk messaged the worker of ${ticket}`,
            ),
          ]),
        )

        // It can't start a second one.
        expect(refusalOf(yield* callOn('another', 'start_run'))).toMatchObject({
          issue: expect.stringContaining('is going already'),
        })
      }).pipe(Effect.scoped),
    runTimeout,
  )

  it.live('refuses a drain with no run going, with no event', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      expect(
        refusalOf(yield* engine.callOn('drain', 'drain_run')),
      ).toMatchObject({ issue: 'the project has no run going' })
      expect(yield* written(engine)).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})

describe('a stop', () => {
  it.live(
    'takes the maintainer’s word in one line, then ends the run with its event',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, say, callOn, yesTo } = engine
        yield* file(engine, 'Never done')
        answerOf(yield* callOn('go', 'start_run'))
        yield* dispatched(engine)

        // Asked, and again before the maintainer has answered: refused, the run going on.
        const asked = yield* say('stop it', [
          { tool: 'stop_run', input: {} },
          { tool: 'stop_run', input: {} },
        ])
        for (const exit of asked)
          expect(refusalOf(exit)).toStrictEqual({
            _tag: 'confirm_first',
            action: 'stop the run',
          })
        expect(yield* client['run.status']({ project })).toMatchObject({
          _tag: 'going',
          header: { state: 'running' },
        })
        expect(actions(yield* written(engine)).map(a => a.tool)).toStrictEqual([
          'start_run',
        ])

        const run = yield* goingRun(engine)
        expect(answerOf(yield* yesTo('stop_run'))).toStrictEqual({
          text: 'Run talk stopped the run',
        })
        yield* ended(engine, run)

        const events = yield* written(engine)
        const stopping = events.findIndex(
          event => event.kind === 'talk_action' && event.tool === 'stop_run',
        )
        expect(stopping).toBeGreaterThan(-1)
        expect(events[stopping]).toMatchObject({ actor: 'run_talk' })
        const last = events.at(-1)
        expect(last).toMatchObject({ kind: 'end', code: 130 })
        expect(stopping).toBeLessThan(events.length - 1)
        expect(events.filter(event => event.kind === 'stop')).toMatchObject([
          { detail: 'INTERRUPTED' },
        ])

        // Stopped, there is nothing left to stop.
        expect(refusalOf(yield* callOn('stop', 'stop_run'))).toMatchObject({
          issue: 'the project has no run going',
        })

        // With no run going, an action is recorded under the last one, and its events are that run's.
        const held = yield* file(engine, 'Later')
        answerOf(
          yield* callOn('label it', 'label_ticket', {
            id: held,
            add: ['later'],
          }),
        )
        const after = yield* written(engine)
        expect(after.at(-1)).toMatchObject({
          kind: 'talk_action',
          tool: 'label_ticket',
          ticket: held,
          run: last?.run,
        })
        expect(
          answerOf(yield* callOn('what happened', 'run_events', { last: 1 })),
        ).toMatchObject([{ tool: 'label_ticket', run: last?.run }])
        expect(answerOf(yield* callOn('how', 'run_view'))).toMatchObject({
          _tag: 'idle',
        })
      }).pipe(Effect.scoped),
    runTimeout,
  )

  it.live(
    'lapses where the maintainer has gone on to something else',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, say, callOn } = engine
        yield* file(engine, 'Never done')
        answerOf(yield* callOn('go', 'start_run'))
        yield* dispatched(engine)
        expect(refusalOf(yield* callOn('stop it', 'stop_run'))).toMatchObject({
          _tag: 'confirm_first',
        })
        yield* say('no, wait')
        // Two messages on, the question it asked no longer stands: it asks again.
        expect(
          refusalOf(yield* callOn('how is it going', 'stop_run')),
        ).toMatchObject({ _tag: 'confirm_first' })
        expect(yield* client['run.status']({ project })).toMatchObject({
          _tag: 'going',
        })
      }).pipe(Effect.scoped),
    runTimeout,
  )
})

describe('the talk’s ticket commands', () => {
  it.live(
    'file, update, defer, label and hold tickets as the talk’s session, each an event',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, callOn } = engine
        const filed = answerOf(
          yield* callOn('file it', 'file_ticket', {
            title: 'Add the switch',
            description: 'The console needs a switch for it.',
            type: 'task',
            files: ['src/switch.ts'],
            labels: ['ui'],
          }),
        )
        const first = yield* client['tickets.list']({
          project,
          filter: {
            status: Option.none(),
            type: Option.none(),
            labels: Option.some(['ui']),
            parent: Option.none(),
          },
        })
        const id = first[0]?.id ?? expect.fail('nothing filed')
        expect(filed).toStrictEqual({
          text: `Run talk filed ${id}: Add the switch`,
        })
        expect(first[0]?.metadata.files).toStrictEqual(
          Option.some(['src/switch.ts']),
        )

        expect(
          answerOf(
            yield* callOn('reword it', 'update_ticket', {
              id,
              title: 'Add the toggle',
              design: 'As agreed.',
            }),
          ),
        ).toStrictEqual({ text: `Run talk updated ${id}: title, design` })
        expect(
          refusalOf(yield* callOn('nothing', 'update_ticket', { id })),
        ).toMatchObject({ issue: 'it names no change' })

        const other = yield* file(engine, 'Before it', 'finish')
        expect(
          answerOf(
            yield* callOn('after that one', 'hold_ticket', {
              ticket: id,
              until: other,
            }),
          ),
        ).toStrictEqual({
          text: `Run talk held ${id} until ${other} merges`,
        })
        expect(
          refusalOf(
            yield* callOn('itself', 'hold_ticket', { ticket: id, until: id }),
          ),
        ).toMatchObject({ issue: 'a ticket is never held until itself' })

        // Read as it is now: held, so not ready, and why.
        expect(
          answerOf(yield* callOn('why', 'ticket_why', { id })),
        ).toMatchObject({
          _tag: 'not_ready',
          reasons: [{ reason: { _tag: 'blocked', by: other } }],
        })
        const ready = answerOf(yield* callOn('ready?', 'tickets_ready'))
        expect(ready).toMatchObject([{ id: other }])
        const shown = answerOf(yield* callOn('show', 'ticket_show', { id }))
        expect(shown).toMatchObject({
          ticket: { title: 'Add the toggle', design: 'As agreed.' },
          labels: ['ui'],
        })

        answerOf(
          yield* callOn('label', 'label_ticket', {
            id,
            add: ['later'],
            remove: ['ui'],
          }),
        )
        const until = '2030-01-01T00:00:00.000Z'
        expect(
          answerOf(yield* callOn('later', 'defer_ticket', { id, until })),
        ).toStrictEqual({ text: `Run talk deferred ${id} until ${until}` })

        const detail = yield* client['tickets.show']({ project, ticket: id })
        expect(detail.ticket.status).toBe('deferred')
        expect(detail.ticket.deferUntil).toStrictEqual(
          Option.some(DateTime.makeUnsafe(until)),
        )
        expect(detail.labels).toStrictEqual(['later'])

        // Each action is an event.
        expect(
          actions(yield* written(engine)).map(({ tool, actor }) => ({
            tool,
            actor,
          })),
        ).toStrictEqual(
          [
            'file_ticket',
            'update_ticket',
            'hold_ticket',
            'label_ticket',
            'defer_ticket',
          ].map(tool => ({ tool, actor: 'run_talk' })),
        )
      }).pipe(Effect.scoped),
  )

  it.live(
    'take no message steered into the turn as the maintainer’s word',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, talk, script, yesTo } = engine
        const id = yield* file(engine, 'Keep me', 'finish')
        const input = { id, reason: 'Done by hand.' }
        const asked = yield* Deferred.make<void>()
        const close = { tool: 'close_ticket', input }
        yield* Queue.offerAll(script.calls, [{ ...close, after: asked }, close])
        yield* client['talk.send']({ talk, text: 'close it' })
        expect(refusalOf(yield* Queue.take(script.answers))).toMatchObject({
          _tag: 'confirm_first',
        })

        // Into the same turn, which goes on to call it again as though answered.
        yield* client['talk.send']({ talk, text: 'how many are left?' })
        yield* Deferred.succeed(asked, undefined)
        expect(refusalOf(yield* Queue.take(script.answers))).toMatchObject({
          _tag: 'confirm_first',
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: id })).ticket
            .status,
        ).toBe('open')

        // The same call in the turn the maintainer's next message opens goes through.
        answerOf(yield* yesTo('close_ticket', input))
        expect(
          (yield* client['tickets.show']({ project, ticket: id })).ticket
            .status,
        ).toBe('closed')
      }).pipe(Effect.scoped),
  )

  it.live(
    'close and cancel a ticket on the maintainer’s word in one line',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, callOn, yesTo } = engine
        const one = yield* file(engine, 'Done by hand', 'finish')
        const two = yield* file(engine, 'Not wanted', 'finish')
        const close = { id: one, reason: 'Done by hand.' }
        const cancel = { id: two, reason: 'Not wanted.' }
        answerOf(
          yield* callOn('after it', 'hold_ticket', { ticket: two, until: one }),
        )

        expect(
          refusalOf(yield* callOn('close it', 'close_ticket', close)),
        ).toStrictEqual({
          _tag: 'confirm_first',
          action: `close ${one} "Done by hand"`,
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: one })).ticket
            .status,
        ).toBe('open')
        expect(answerOf(yield* yesTo('close_ticket', close))).toStrictEqual({
          text: `Run talk closed ${one}: Done by hand`,
          also: `Still open behind it: ${two}`,
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: one })).ticket,
        ).toMatchObject({
          status: 'closed',
          resolution: Option.some('done'),
        })

        expect(
          refusalOf(yield* callOn('cancel it', 'cancel_ticket', cancel)),
        ).toStrictEqual({
          _tag: 'confirm_first',
          action: `cancel ${two} "Not wanted"`,
        })
        answerOf(yield* yesTo('cancel_ticket', cancel))
        expect(
          (yield* client['tickets.show']({ project, ticket: two })).ticket,
        ).toMatchObject({ resolution: Option.some('cancelled') })

        expect(
          actions(yield* written(engine)).map(({ tool, ticket }) => [
            tool,
            ticket,
          ]),
        ).toStrictEqual([
          ['hold_ticket', two],
          ['close_ticket', one],
          ['cancel_ticket', two],
        ])
      }).pipe(Effect.scoped),
  )

  it.live(
    'answer a question in the maintainer’s words, and open the answer talk',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { client, project, callOn, script } = engine
        const asked = yield* client['tickets.create']({
          project,
          ticket: {
            type: 'manual',
            title: 'Rotate the key',
            description: Option.none(),
            design: Option.none(),
            acceptance: Option.none(),
            priority: Option.none(),
            labels: Option.none(),
            parent: Option.none(),
            metadata: Option.none(),
            model: Option.none(),
          },
        })
        expect(
          answerOf(yield* callOn('what waits', 'open_requests')),
        ).toMatchObject([{ _tag: 'task', ticket: asked.id }])

        expect(
          refusalOf(
            yield* callOn('answer', 'answer_question', {
              question: TicketId.make('fa-none'),
              answer: 'Blue.',
            }),
          ),
        ).toMatchObject({ _tag: 'invalid' })

        const opened = answerOf(yield* callOn('open it', 'open_answer_talk'))
        const started = yield* Ref.get(script.started)
        expect(started.map(({ mode }) => mode)).toStrictEqual(['run', 'answer'])
        // Named, so that a client reaches it, by its answer or its record.
        const answerTalk = started[1]?.talk
        expect(opened).toStrictEqual({
          text: `Run talk opened the answer talk ${answerTalk}`,
          talk: answerTalk,
          model: 'anthropic/claude-opus-5-5',
        })
        expect(actions(yield* written(engine))).toMatchObject([
          { tool: 'open_answer_talk', talk: answerTalk },
        ])
      }).pipe(Effect.scoped),
  )
})

// The answers to what waits on the maintainer, on the attention requests' own side alone: the mode's
// tools given a stand-in that records what they answer, and a talk's word as the test says it.
describe('answers through the talk', () => {
  const permissionId = PermissionId.make('p-1')
  const ticket = TicketId.make('fa-1')
  const project = ProjectId.make('work')
  const request = AttentionRequest.cases.permission.make({
    project,
    id: permissionId,
    ticket,
    session: SessionId.make('s-1'),
    tool: 'bash',
    input: { command: 'ls' },
    shown: { _tag: 'command', lines: ['ls'] },
    why: 'it runs a command',
    openedAt: DateTime.makeUnsafe(0),
  })
  /** Another of the same tool on the same ticket. */
  const otherId = PermissionId.make('p-3')
  const other = AttentionRequest.cases.permission.make({
    ...request,
    id: otherId,
    input: { command: 'rm -rf ~' },
    shown: { _tag: 'command', lines: ['rm -rf ~'] },
  })

  const unused = Effect.die('not asked of it by these tools')
  const talkActor = Actor.cases.talk.make({
    session: SessionId.make('s-talk'),
  })

  /** The run mode on stand-ins, and on `graph`: the answers it gave, and the records it wrote. */
  const standIn = Effect.fn(function* (
    graph: Effect.Effect<WorkGraphShape> = unused,
  ) {
    const answers = yield* Ref.make<
      ReadonlyArray<{ readonly answer: AttentionAnswer; readonly by: string }>
    >([])
    const records = yield* Ref.make<ReadonlyArray<EventDraft>>([])
    const attention: AttentionRequestsShape = {
      list: () => Effect.succeed([request, other]),
      watch: () => Stream.die('not asked of it by these tools'),
      answer: input =>
        Effect.as(
          Ref.update(answers, all => [...all, input]),
          new Answered({ by: input.by, at: DateTime.makeUnsafe(0) }),
        ),
      revise: () => unused,
      reviews: () => unused,
      forRun: unused,
    }
    const runs: RunsShape = {
      start: () => unused,
      record: (_project, draft) => Ref.update(records, all => [...all, draft]),
      stop: () => unused,
      drain: () => unused,
      undrain: () => unused,
      status: () => unused,
      hosted: unused,
      watchEvents: () => Stream.die('not asked of it by these tools'),
      watchTalkActions: () => Stream.die('not asked of it by these tools'),
      watchView: () => Stream.die('not asked of it by these tools'),
      message: () => unused,
      interrupt: () => unused,
      release: () => unused,
      watchTranscript: () => Stream.die('not asked of it by these tools'),
    }
    const projects: ProjectsShape = {
      add: () => unused,
      list: unused,
      remove: () => unused,
      find: () => unused,
      setTrusted: () => unused,
      setRun: () => unused,
      worktreeHome: () => unused,
      settings: () => unused,
      setSettings: () => unused,
      workGraph: () => unused,
      onBase: () => unused,
      watchStatus: () => Stream.die('not asked of it by these tools'),
    }
    const mode = runMode({ runs, attention, projects })
    /** Calls `tool`, the maintainer having answered or not. */
    const call = (tool: string, input: unknown, confirmed: boolean) => {
      const context: TalkToolContext<'run'> = {
        talk: TalkId.make('talk-1'),
        project: {
          id: project,
          name: 'Work',
          path: '/nowhere',
          origin: 'registered',
          url: Option.none(),
          base: 'main',
          trusted: true,
        },
        context: { _tag: 'run' },
        graph,
        actor: talkActor,
        maintainerMessages: Effect.succeed(0),
        confirmed: () => Effect.succeed(confirmed),
        openTalk: () => unused,
      }
      const found = mode.tools.find(({ tool: { name } }) => name === tool)
      return Effect.exit(
        found === undefined
          ? Effect.die(`no tool ${tool}`)
          : found.call(input, context),
      )
    }
    return { answers, records, call }
  })

  it.effect('allows a permission request only on the maintainer’s word', () =>
    Effect.gen(function* () {
      const { answers, records, call } = yield* standIn()
      const allow = { id: permissionId, decision: { _tag: 'allow_once' } }
      expect(
        refusalOf(yield* call('answer_permission', allow, false)),
      ).toStrictEqual({
        _tag: 'confirm_first',
        action: `allow bash for ${ticket} once, request ${permissionId}: ls`,
      })
      expect(yield* Ref.get(answers)).toStrictEqual([])
      expect(yield* Ref.get(records)).toStrictEqual([])

      expect(
        answerOf(yield* call('answer_permission', allow, true)),
      ).toStrictEqual({ text: `Run talk allowed bash for ${ticket} once` })
      expect(yield* Ref.get(answers)).toMatchObject([
        {
          answer: {
            _tag: 'permission',
            id: permissionId,
            decision: { _tag: 'allow_once' },
          },
          by: 'the run talk',
        },
      ])
      expect(yield* Ref.get(records)).toStrictEqual([
        {
          kind: 'talk_action',
          actor: 'run_talk',
          tool: 'answer_permission',
          ticket,
          text: `Run talk allowed bash for ${ticket} once`,
        },
      ])
    }),
  )

  it.effect(
    'asks about each permission request by itself, naming its call',
    () =>
      Effect.gen(function* () {
        const { call } = yield* standIn()
        expect(
          refusalOf(
            yield* call(
              'answer_permission',
              { id: otherId, decision: { _tag: 'allow_once' } },
              false,
            ),
          ),
        ).toStrictEqual({
          _tag: 'confirm_first',
          action: `allow bash for ${ticket} once, request ${otherId}: rm -rf ~`,
        })
      }),
  )

  it.effect('refuses a permission request without asking', () =>
    Effect.gen(function* () {
      const { answers, call } = yield* standIn()
      expect(
        answerOf(
          yield* call(
            'answer_permission',
            { id: permissionId, decision: { _tag: 'refuse', note: null } },
            false,
          ),
        ),
      ).toStrictEqual({ text: `Run talk refused bash for ${ticket}` })
      expect(yield* Ref.get(answers)).toHaveLength(1)
    }),
  )

  it.effect('refuses an answer to a permission request not open', () =>
    Effect.gen(function* () {
      const { call } = yield* standIn()
      expect(
        refusalOf(
          yield* call(
            'answer_permission',
            { id: 'p-2', decision: { _tag: 'allow_run' } },
            true,
          ),
        ),
      ).toMatchObject({ issue: 'no permission request p-2 is open' })
    }),
  )

  it.effect('answers a question in the maintainer’s words, as its text', () =>
    Effect.gen(function* () {
      const { answers, records, call } = yield* standIn()
      const question = TicketId.make('fa-q1')
      expect(
        answerOf(
          yield* call(
            'answer_question',
            { question, answer: 'Blue, as we said.' },
            false,
          ),
        ),
      ).toStrictEqual({
        text: `Run talk answered ${question} in the maintainer's words`,
      })
      expect(yield* Ref.get(answers)).toMatchObject([
        {
          answer: {
            _tag: 'question',
            ticket: question,
            answer: { _tag: 'text', text: 'Blue, as we said.' },
          },
          by: 'the run talk',
        },
      ])
      expect(yield* Ref.get(records)).toMatchObject([
        { tool: 'answer_question', ticket: question },
      ])
    }),
  )

  it.effect('changes the work graph as the talk’s session', () =>
    Effect.gen(function* () {
      const graph = Context.get(
        yield* Layer.build(
          Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
            Layer.provide(storeLayer(':memory:')),
          ),
        ),
        WorkGraph,
      )
      const filed = yield* Effect.orDie(
        graph.create({
          ticket: { type: 'task', title: 'First' },
          actor: Actor.cases.maintainer.make({}),
        }),
      )
      const { call } = yield* standIn(Effect.succeed(graph))
      answerOf(
        yield* call('label_ticket', { id: filed.id, add: ['later'] }, false),
      )
      const changes = yield* Effect.orDie(graph.history(filed.id))
      expect(changes.at(-1)).toMatchObject({
        actor: Option.some(talkActor),
        change: { _tag: 'labelled', label: 'later' },
      })
    }).pipe(Effect.scoped),
  )
})
