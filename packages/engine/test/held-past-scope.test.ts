import {
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  AlreadyAnswered,
  AttentionAnswer,
  AttentionNotFound,
  AttentionRequest,
  PermissionDecision,
  PermissionId,
  PermissionShown,
  Phase,
  ProjectId,
  RunId,
  SessionId,
  TicketId,
  ToolCallId,
} from '@fabrica/contracts'

import { make as makeAttention } from '../src/attention'
import { ProxyEvent, layerOpen, make as makeProxy } from '../src/proxy'
import { makeRunState } from '../src/run'
import { RunLog, layerRunLog } from '../src/runlog'
import { Secrets } from '../src/secrets'
import { makeWorkerDesk } from '../src/view'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { routesAt, testSecrets } from './scripted-run'

// What a scope held goes with it (spec §7.1, H77), as soak.test.ts found: a done ticket's transcript goes
// though its run goes on; a run's word on the proxy goes with the run; the answers kept for a later
// answer to be told who came first don't grow for as long as the engine lives.

const ticket = TicketId.make('wk-a1')

describe("a done ticket's worker", () => {
  it.effect('leaves the desk: its watches end, its transcript gone', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const desk = yield* makeWorkerDesk({
        flush: Duration.millis(50),
        scope,
      })
      yield* desk.enter({
        ticket,
        session: SessionId.make('worker-1'),
        model: 'anthropic/claude-opus-5-5',
      })
      const watching = yield* desk.watchTranscript(ticket, Option.none())
      const watch = yield* Option.getOrThrow(watching).pipe(
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* desk.message({ ticket, text: 'Look here', merging: true })

      yield* desk.forget(ticket)

      const items = yield* Fiber.join(watch)
      expect(items.length).toBeGreaterThan(0)
      expect(yield* desk.watchTranscript(ticket, Option.none())).toEqual(
        Option.none(),
      )
      expect(yield* desk.current).toEqual([])
    }),
  )

  it.effect(
    'is told as its ticket goes to a done phase, and not to one a later dispatch takes it up from',
    () =>
      Effect.gen(function* () {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-done-')))
        const done = yield* Ref.make<ReadonlyArray<TicketId>>([])
        yield* Effect.gen(function* () {
          const state = yield* makeRunState(
            yield* RunLog,
            () => Effect.succeed({}),
            () => Effect.void,
            id => Ref.update(done, all => [...all, id]),
          )
          yield* state.enter({ ticket, title: 'Build the page' })
          yield* state.dispatch({
            ticket,
            title: 'Build the page',
            limit: Option.none(),
          })
          const move = (to: Phase) => state.move({ ticket, to, cause: 'test' })
          yield* move(Phase.cases.stopped.make({}))
          yield* move(Phase.cases.queued.make({}))
          expect(yield* Ref.get(done)).toEqual([])
          yield* move(Phase.cases.no_change.make({}))
          expect(yield* Ref.get(done)).toEqual([ticket])
        }).pipe(
          Effect.provide(
            layerRunLog({ root, run: RunId.make('run-done') }).pipe(
              Layer.provide(DateTime.layerCurrentZoneOffset(0)),
            ),
          ),
        )
      }),
  )
})

describe('the model proxy', () => {
  it.live(
    "forgets a run's calls that went through as it ends: a refused key is a failed start again",
    () =>
      Effect.gen(function* () {
        let status = 200
        const server = createServer((request, response) => {
          request.resume()
          request.on('end', () => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end('{}')
          })
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.close()
            server.closeAllConnections()
          }),
        )
        const url = yield* Effect.callback<string>(resume => {
          server.listen({ host: '127.0.0.1', port: 0 }, () => {
            const address = server.address()
            const port =
              typeof address === 'object' && address !== null ? address.port : 0
            resume(Effect.succeed(`http://127.0.0.1:${port}`))
          })
        })
        const proxy = yield* makeProxy({ routes: routesAt(url) }).pipe(
          Effect.provideService(Secrets, testSecrets),
          Effect.provide(layerOpen),
        )
        const run = RunId.make('run-1')
        const caller = {
          run,
          ticket: Option.some(ticket),
          session: Option.some(SessionId.make('session-1')),
          model: 'claude-sonnet-4-5',
        }
        const agent = yield* proxy.grant(caller)
        const send = Effect.promise(() =>
          fetch(`${agent.baseUrls['anthropic']}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': Redacted.value(agent.token),
            },
            body: '{"model":"m"}',
          }).then(response => response.text()),
        )
        const refusals = (yield* proxy.events).pipe(
          Stream.filter(ProxyEvent.$is('Refused')),
          Stream.map(({ refusal }) => refusal._tag),
          Stream.take(2),
          Stream.runCollect,
        )
        const heard = yield* Effect.forkChild(refusals)
        yield* Effect.yieldNow

        yield* send
        status = 401
        yield* send
        yield* proxy.forgetRun(run)
        yield* send

        expect(yield* Fiber.join(heard)).toEqual([
          'CredentialRefused',
          'StartFailed',
        ])
      }).pipe(Effect.scoped),
  )
})

describe('the answers kept', () => {
  const project = ProjectId.make('app')
  const permission = (at: number) => ({
    project,
    ticket,
    session: SessionId.make('session-1'),
    toolCall: ToolCallId.make(`call-${at}`),
    tool: 'bash',
    input: { command: `curl https://example.com/${at}` },
    shown: PermissionShown.cases.command.make({
      lines: [`curl https://example.com/${at}`],
    }),
    why: 'a network-reaching command not on the list',
  })

  it.effect(
    'tell a late answer who came first, as far back as the most kept, and no further',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const attention = yield* makeAttention({
          list: Effect.succeed([project]),
          changed: Stream.never,
          graph: () => Effect.succeed(graph),
          events: () => Effect.succeed([]),
        })
        const forRun = yield* attention.forRun
        const answerAt = (id: PermissionId) =>
          attention.answer({
            answer: AttentionAnswer.cases.permission.make({
              project,
              id,
              decision: PermissionDecision.cases.refuse.make({
                note: Option.none(),
              }),
            }),
            by: 'app',
          })
        const ids: Array<PermissionId> = []
        for (let at = 0; at < 1100; at += 1) {
          const asking = yield* Effect.forkChild(
            forRun.permission(permission(at)),
          )
          yield* Effect.yieldNow
          const listed = (yield* attention.list(Option.some(project))).filter(
            AttentionRequest.guards.permission,
          )
          const asked = listed[0]
          if (asked === undefined) return expect.fail('nothing was asked')
          yield* answerAt(asked.id)
          yield* Fiber.join(asking)
          ids.push(asked.id)
        }

        const again = (at: number) =>
          answerAt(ids[at] ?? expect.fail(`nothing asked at ${at}`)).pipe(
            Effect.flip,
          )
        expect(yield* again(1099)).toBeInstanceOf(AlreadyAnswered)
        expect(yield* again(0)).toBeInstanceOf(AttentionNotFound)
      }).pipe(
        Effect.provide(
          Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
            Layer.provide(storeLayer(':memory:')),
          ),
        ),
        Effect.scoped,
      ),
  )
})
