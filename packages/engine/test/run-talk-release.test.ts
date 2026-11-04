import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  Actor,
  ProjectId,
  SessionId,
  TalkId,
  TicketId,
  WorkerNotFound,
} from '@fabrica/contracts'

import { type Agent, AgentOwner } from '../src/agent'
import type { AttentionRequestsShape } from '../src/attention'
import type { ProjectsShape } from '../src/projects'
import type { RunsShape } from '../src/run/registry'
import type { EventDraft } from '../src/runlog'
import { type TalkToolContext, runMode } from '../src/talks'
import { makeWorkerDesk } from '../src/view'

// A worker steered from the run talk (spec §15.4, §18.4): the message's answer says it waits for its
// release, and it does, until the talk's release hands it back to the engine; each is a record with
// actor `run_talk`. The talk's tools here go through a real worker desk, whose worker's agent is a
// stand-in; a release of a worker that isn't steered, or isn't there, is refused and leaves no record,
// and a release takes no confirmation.

const ticket = TicketId.make('fa-1')
const project = ProjectId.make('work')
const released = 'Carry on'

const unused = Effect.die('not asked of it by these tools')

/** A worker's agent whose prompts are kept: its first turn runs until `gate` opens. */
const agentOf = Effect.fn(function* (gate: Deferred.Deferred<void>) {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const agent: Agent = {
    owner: AgentOwner.Ticket({ ticket }),
    pid: 1,
    session: { id: SessionId.make('worker-1'), file: Option.none() },
    events: Effect.succeed(Stream.never),
    prompt: text =>
      Ref.update(prompts, all => [...all, text]).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.as({ disposition: 'started' as const, aborted: false }),
      ),
    steer: () => Effect.succeed('started' as const),
    abort: Effect.void,
    setModel: () => Effect.void,
    switchSession: () => Effect.succeed(true),
    fork: () => Effect.die('not forked'),
    sessionStats: Effect.die('no stats'),
    exit: Effect.never,
    close: Effect.void,
  }
  return { agent, prompts: Ref.get(prompts) }
})

/** The run mode on a desk with the one worker, in `scope`: the desk, the records and the tools' calls. */
const talkIn = Effect.fn(function* (scope: Scope.Scope) {
  const desk = yield* makeWorkerDesk({ flush: Duration.seconds(1), scope })
  yield* desk.enter({
    ticket,
    session: SessionId.make('worker-1'),
    model: 'anthropic/claude-opus-5-5',
  })
  const records = yield* Ref.make<ReadonlyArray<EventDraft>>([])
  const notFound = (at: { readonly ticket: TicketId }) =>
    Effect.fail(new WorkerNotFound({ project, ticket: at.ticket }))
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
    message: at =>
      desk.message({ ticket: at.ticket, text: at.text, merging: false }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => notFound(at),
            onSome: () => Effect.void,
          }),
        ),
      ),
    interrupt: () => unused,
    release: at =>
      Effect.flatMap(
        desk.release(at.ticket),
        Option.match({
          onNone: () => notFound(at),
          onSome: Effect.succeed,
        }),
      ),
    watchTranscript: () => Stream.die('not asked of it by these tools'),
  }
  const attention: AttentionRequestsShape = {
    list: () => unused,
    watch: () => Stream.die('not asked of it by these tools'),
    answer: () => unused,
    revise: () => unused,
    reviews: () => unused,
    forRun: unused,
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
    graph: unused,
    actor: Actor.cases.talk.make({ session: SessionId.make('s-talk') }),
    maintainerMessages: Effect.succeed(0),
    // A release or a message that asked would die here.
    confirmed: () => unused,
    openTalk: () => unused,
  }
  const call = (tool: string, input: unknown) => {
    const found = mode.tools.find(({ tool: { name } }) => name === tool)
    return Effect.exit(
      found === undefined
        ? Effect.die(`no tool ${tool}`)
        : found.call(input, context),
    )
  }
  return { desk, records: Ref.get(records), call }
})

const answerOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? exit.value : expect.fail(String(exit.cause))

const refused = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap(reason =>
        reason._tag === 'Fail' ? [reason.error] : [],
      )
    : []
}

describe('a worker steered from the run talk', () => {
  it.effect(
    'waits for its release, as the message’s answer says, and the talk’s release sends it on',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { desk, records, call } = yield* talkIn(scope)
        const gate = yield* Deferred.make<void>()
        const { agent, prompts } = yield* agentOf(gate)
        const turns = yield* desk
          .converse({
            ticket,
            agent,
            prompt: 'Build the page',
            released,
            settled: Effect.succeed(false),
          })
          .pipe(Effect.scoped, Effect.forkChild)
        yield* Effect.yieldNow

        expect(
          answerOf(
            yield* call('message_worker', { ticket, text: 'Use the new one' }),
          ),
        ).toStrictEqual({
          text: `Run talk messaged the worker of ${ticket}`,
          also: 'Unless it settles its ticket, the worker now waits for its release: release_worker hands it back to the engine.',
        })

        // Its turn ends, and the engine sends it nothing, however long.
        yield* Deferred.succeed(gate, undefined)
        yield* TestClock.adjust(Duration.hours(1))
        expect(yield* prompts).toEqual(['Build the page'])
        expect((yield* desk.current).map(({ steered }) => steered)).toEqual([
          true,
        ])

        expect(
          answerOf(yield* call('release_worker', { ticket })),
        ).toStrictEqual({ text: `Run talk released the worker of ${ticket}` })
        yield* Fiber.join(turns)
        expect(yield* prompts).toEqual(['Build the page', released])
        expect((yield* desk.current).map(({ steered }) => steered)).toEqual([
          false,
        ])

        expect(yield* records).toStrictEqual([
          {
            kind: 'talk_action',
            actor: 'run_talk',
            tool: 'message_worker',
            ticket,
            text: `Run talk messaged the worker of ${ticket}`,
          },
          {
            kind: 'talk_action',
            actor: 'run_talk',
            tool: 'release_worker',
            ticket,
            text: `Run talk released the worker of ${ticket}`,
          },
        ])
      }),
  )

  it.effect('is refused a release once it has had it, with no record', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { records, call } = yield* talkIn(scope)
      yield* call('message_worker', { ticket, text: 'Look here' })
      yield* call('release_worker', { ticket })
      const before = yield* records

      expect(refused(yield* call('release_worker', { ticket }))).toMatchObject([
        { _tag: 'invalid', issue: `the worker of ${ticket} isn't steered` },
      ])
      expect(yield* records).toStrictEqual(before)
    }),
  )

  it.effect(
    'is refused a release of a worker never steered, with no record',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { records, call } = yield* talkIn(scope)

        expect(
          refused(yield* call('release_worker', { ticket })),
        ).toMatchObject([
          { _tag: 'invalid', issue: `the worker of ${ticket} isn't steered` },
        ])
        expect(yield* records).toStrictEqual([])
      }),
  )

  it.effect(
    'is refused a release at a ticket with no worker, with no record',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { records, call } = yield* talkIn(scope)
        const other = TicketId.make('fa-2')

        expect(
          refused(yield* call('release_worker', { ticket: other })),
        ).toMatchObject([
          {
            _tag: 'invalid',
            issue: `no worker is at ${other} in the project's run`,
          },
        ])
        expect(yield* records).toStrictEqual([])
      }),
  )
})
