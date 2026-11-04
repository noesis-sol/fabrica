import { Duration, Effect, Layer, Option } from 'effect'
import { RpcClient, RpcSerialization, RpcTest } from 'effect/rpc'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeSocket from '@effect/platform-node-shared/NodeSocket'
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'
import {
  CommandSetting,
  ControlRpcs,
  ControlTokenVariable,
  GateCounts,
  GateReason,
  GateVerdict,
  InsightsQuery,
  PermissionDecision,
  PermissionShown,
  ProjectId,
  ProjectNotFound,
  ProjectSource,
  Retention,
  ReviewRpcs,
  RunId,
  SessionId,
  TicketId,
  ToolCallId,
  controlTokenClient,
} from '@fabrica/contracts'

import { layer as checksLayer } from '../src/checks'
import {
  Attention,
  ControlRole,
  ControlServer,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../src/control'
import { engineDatabaseLayer } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { Projects, layer as projectsLayer } from '../src/projects'
import { reviewHandlersOn } from '../src/rpc/review'
import {
  Telemetry,
  TelemetryDb,
  TelemetryRow,
  TelemetryStore,
  readGateCounts,
  runNamedQuery,
  telemetryDbLayer,
  telemetryLayer,
} from '../src/telemetry'
import { metadataOnly } from '../src/telemetry/metadata'
import { layerWake, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// The gate's decisions counted per ticket (spec §12.6, §21): reports over a real control channel,
// recorded in an in-memory telemetry store, read back for the reviewer and the Review screen, and by
// the Insights group's named query; a reason stays out of an export.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-gate-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: { PATH: `${gitFolder}:/usr/bin:/bin`, HOME: home },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 1, spacing: Duration.zero },
}

const project = ProjectId.make('app')
const ticket = TicketId.make('fa-a1b2')
const other = TicketId.make('fa-c3d4')
const run = RunId.make('r-1')
const later = RunId.make('r-2')
const wait = Duration.seconds(5)

const telemetry = () =>
  telemetryLayer({
    filename: ':memory:',
    retention: {
      raw: Retention.cases.Forever.make({}),
      daily: Retention.cases.Forever.make({}),
    },
  })

/** The control server on telemetry in memory, each permission request answered once `wait` has passed. */
const controlServices = () => {
  const runner = Layer.provide(runnerLayer(runnerConfig()), layerClock)
  const git = Layer.provide(gitLayer(gitConfig), runner)
  return controlLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        checkOwnPassesLayer.pipe(
          Layer.provideMerge(
            Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })),
          ),
          Layer.provideMerge(storeLayer(':memory:')),
        ),
        git,
        Layer.provide(checksLayer, Layer.merge(runner, git)),
        Layer.provide(layerWake, noSleepCauses),
        Layer.succeed(Attention)({
          permission: () =>
            Effect.as(
              TestClock.adjust(wait),
              PermissionDecision.cases.allow_once.make({}),
            ),
          autoAnswer: () => Effect.succeedNone,
        }),
      ),
    ),
    Layer.provideMerge(telemetry()),
  )
}

/** A client of a control channel open for `role`, on the live clock. */
const gateClient = (role: ControlRole) =>
  Effect.gen(function* () {
    const folder = mkdtempSync(join(root, 's-'))
    const control = yield* (yield* ControlServer).open({
      project,
      ticket,
      session: SessionId.make('session-1'),
      run,
      role,
      worktree: folder,
      folder,
      questionWait: Duration.minutes(15),
      mergeStanding: Effect.succeed('not_queued'),
      checkOwn: {
        command: CommandSetting.cases.Unset.make({}),
        checkout: folder,
        timeLimit: Duration.minutes(1),
        cores: 1,
        nice: Option.none(),
      },
    })
    return yield* TestClock.withLive(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.mergeAll(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(NodeSocket.layerNet({ path: control.socket })),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
            controlTokenClient(control.environment[ControlTokenVariable] ?? ''),
          ),
        )
        return yield* Effect.provide(RpcClient.make(ControlRpcs), context)
      }),
    )
  })

const toolCall = (id: string) => ToolCallId.make(id)

const allowed = GateVerdict.cases.allowed.make({})
const asked = GateVerdict.cases.asked.make({
  why: 'writes outside the worktree',
  decision: PermissionDecision.cases.allow_once.make({}),
})
const refused = GateVerdict.cases.refused.make({
  reason: 'git push: workers never push',
})

const everyDecision = { project, ticket: Option.none(), run: Option.none() }

describe("the gate's decisions per ticket", () => {
  it.effect(
    'three reports for one ticket, allowed, asked and refused, count 1/1/1',
    () =>
      Effect.gen(function* () {
        const client = yield* gateClient(ControlRole.Worker())
        yield* client.report_gate_decision({
          toolCall: toolCall('call-1'),
          tool: 'read',
          verdict: allowed,
        })
        yield* client.report_gate_decision({
          toolCall: toolCall('call-2'),
          tool: 'write',
          verdict: asked,
        })
        yield* client.report_gate_decision({
          toolCall: toolCall('call-3'),
          tool: 'bash',
          verdict: refused,
        })
        const counts = yield* readGateCounts(everyDecision)
        expect(counts).toEqual([
          new GateCounts({
            ticket,
            allowed: 1,
            asked: 1,
            refused: 1,
            reasons: [
              new GateReason({
                verdict: 'refused',
                reason: 'git push: workers never push',
                count: 1,
              }),
              new GateReason({
                verdict: 'asked',
                reason: 'writes outside the worktree',
                count: 1,
              }),
            ],
          }),
        ])
      }).pipe(Effect.scoped, Effect.provide(controlServices())),
  )

  it.effect(
    'a row says how long its request waited, and whether the call went ahead',
    () =>
      Effect.gen(function* () {
        const client = yield* gateClient(ControlRole.Worker())
        const decision = yield* client.request_permission({
          toolCall: toolCall('call-1'),
          tool: 'write',
          input: { path: '/elsewhere' },
          shown: PermissionShown.cases.call.make({
            input: { path: '/elsewhere' },
          }),
          why: 'writes outside the worktree',
        })
        expect(decision).toEqual(PermissionDecision.cases.allow_once.make({}))
        yield* client.report_gate_decision({
          toolCall: toolCall('call-1'),
          tool: 'write',
          verdict: GateVerdict.cases.asked.make({
            why: 'writes outside the worktree',
            decision,
          }),
        })
        yield* client.report_gate_decision({
          toolCall: toolCall('call-2'),
          tool: 'write',
          verdict: GateVerdict.cases.asked.make({
            why: 'writes outside the worktree',
            decision: PermissionDecision.cases.refuse.make({
              note: Option.none(),
            }),
          }),
        })
        yield* client.report_gate_decision({
          toolCall: toolCall('call-3'),
          tool: 'bash',
          verdict: refused,
        })
        yield* (yield* Telemetry).flush
        const sql = yield* TelemetryStore
        const rows = yield* sql<{
          readonly ticket: string
          readonly run: string
          readonly duration_ms: number
          readonly allowed: number
          readonly asked: number
        }>`SELECT ticket, run, duration_ms, allowed, asked FROM tool_calls ORDER BY rowid`
        expect(rows).toEqual([
          { ticket, run, duration_ms: 5000, allowed: 1, asked: 1 },
          { ticket, run, duration_ms: 0, allowed: 0, asked: 1 },
          { ticket, run, duration_ms: 0, allowed: 0, asked: 0 },
        ])
        const [counts] = yield* readGateCounts(everyDecision)
        expect(counts?.asked).toBe(2)
        expect(counts?.refused).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(controlServices())),
  )

  it.effect("an organ's session counts under no ticket", () =>
    Effect.gen(function* () {
      const client = yield* gateClient(
        ControlRole.Organ({ answer: () => Effect.void }),
      )
      yield* client.report_gate_decision({
        toolCall: toolCall('call-1'),
        tool: 'bash',
        verdict: refused,
      })
      expect(yield* readGateCounts(everyDecision)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(controlServices())),
  )

  it.effect('records no more of a long reason than a reader can take', () =>
    Effect.gen(function* () {
      const client = yield* gateClient(ControlRole.Worker())
      yield* client.report_gate_decision({
        toolCall: toolCall('call-1'),
        tool: 'bash',
        verdict: GateVerdict.cases.refused.make({ reason: 'x'.repeat(4000) }),
      })
      const [counts] = yield* readGateCounts(everyDecision)
      expect(counts?.reasons[0]?.reason).toHaveLength(500)
    }).pipe(Effect.scoped, Effect.provide(controlServices())),
  )

  const row = (fields: {
    readonly ticket: TicketId
    readonly run: RunId
    readonly allowed: boolean
    readonly asked: boolean
    readonly reason?: string
  }) =>
    TelemetryRow.ToolCall({
      project,
      tool: 'bash',
      duration: Duration.zero,
      ...fields,
    })

  const recorded = Effect.gen(function* () {
    const { record } = yield* Telemetry
    yield* Effect.forEach(
      [
        row({ ticket, run, allowed: true, asked: false }),
        row({ ticket, run, allowed: true, asked: false }),
        row({ ticket, run, allowed: false, asked: false, reason: 'once' }),
        row({ ticket, run, allowed: false, asked: false, reason: 'twice' }),
        row({ ticket, run, allowed: false, asked: false, reason: 'twice' }),
        row({ ticket: other, run, allowed: true, asked: true, reason: 'why' }),
        row({ ticket, run: later, allowed: true, asked: false }),
      ],
      record,
      { discard: true },
    )
  })

  it.effect(
    'keeps to the ticket or the run named, reasons most given first',
    () =>
      Effect.gen(function* () {
        yield* recorded
        const inRun = yield* readGateCounts({
          project,
          ticket: Option.none(),
          run: Option.some(run),
        })
        expect(inRun).toEqual([
          new GateCounts({
            ticket,
            allowed: 2,
            asked: 0,
            refused: 3,
            reasons: [
              new GateReason({ verdict: 'refused', reason: 'twice', count: 2 }),
              new GateReason({ verdict: 'refused', reason: 'once', count: 1 }),
            ],
          }),
          new GateCounts({
            ticket: other,
            allowed: 0,
            asked: 1,
            refused: 0,
            reasons: [
              new GateReason({ verdict: 'asked', reason: 'why', count: 1 }),
            ],
          }),
        ])
        const ofTicket = yield* readGateCounts({
          project,
          ticket: Option.some(ticket),
          run: Option.none(),
        })
        expect(ofTicket.map(counts => [counts.ticket, counts.allowed])).toEqual(
          [[ticket, 3]],
        )
        expect(
          yield* readGateCounts({
            project: ProjectId.make('elsewhere'),
            ticket: Option.none(),
            run: Option.none(),
          }),
        ).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(telemetry())),
  )

  const withQueryLayer = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(
      Effect.scoped,
      Effect.provide(
        telemetryDbLayer(':memory:').pipe(
          Layer.provideMerge(
            Layer.effect(SqlClient.SqlClient, Effect.service(TelemetryStore)),
          ),
          Layer.provideMerge(telemetry()),
        ),
      ),
    )

  it.effect('answers the named query by ticket, verdict and reason', () =>
    withQueryLayer(
      Effect.gen(function* () {
        yield* recorded
        yield* (yield* Telemetry).flush
        yield* (yield* TelemetryDb).refresh([])
        const table = yield* runNamedQuery(
          InsightsQuery.cases.gate_decisions.make({
            project: Option.some(project),
            ticket: Option.none(),
            run: Option.some(run),
            since: Option.none(),
          }),
          { events: [], sessions: [] },
        )
        expect(table.columns.map(({ name }) => name)).toEqual([
          'ticket',
          'verdict',
          'reason',
          'decisions',
        ])
        expect(
          table.rows.map(cells => cells.map(cell => Option.getOrNull(cell))),
        ).toEqual([
          [ticket, 'allowed', null, 2],
          [ticket, 'refused', 'twice', 2],
          [ticket, 'refused', 'once', 1],
          [other, 'asked', 'why', 1],
        ])
      }),
    ),
  )

  it.effect('leaves a reason out of every export', () =>
    withQueryLayer(
      Effect.gen(function* () {
        yield* recorded
        yield* (yield* Telemetry).flush
        const db = yield* TelemetryDb
        yield* db.refresh([])
        const folder = mkdtempSync(join(root, 'export-'))
        yield* db.exportParquet(folder)
        const columns = yield* db.rows(
          `SELECT name FROM parquet_schema($file) WHERE num_children IS NULL`,
          { file: join(folder, 'tool_calls.parquet') },
        )
        const names = columns.map(({ name }) => name)
        expect(names).toContain('allowed')
        expect(names).not.toContain('reason')
        expect(
          metadataOnly({
            attributes: [
              { key: 'tool', value: { stringValue: 'bash' } },
              { key: 'reason', value: { stringValue: 'git push' } },
            ],
          }),
        ).toEqual({
          attributes: [{ key: 'tool', value: { stringValue: 'bash' } }],
        })
      }),
    ),
  )

  const reviewClient = Effect.gen(function* () {
    const checkout = mkdtempSync(join(root, 'checkout-'))
    const env = {
      PATH: `${gitFolder}:/usr/bin:/bin`,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
    }
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: checkout,
      env,
    })
    execFileSync(
      'git',
      ['commit', '--quiet', '--allow-empty', '--message', 'one'],
      { cwd: checkout, env },
    )
    const data = mkdtempSync(join(root, 'data-'))
    const services = yield* Layer.build(
      reviewHandlersOn.pipe(
        Layer.provideMerge(projectsLayer),
        Layer.provideMerge(telemetry()),
        Layer.provide(
          gitLayer(gitConfig).pipe(
            Layer.provide(runnerLayer(runnerConfig())),
            Layer.provide(layerClock),
          ),
        ),
        Layer.provide(engineDatabaseLayer(':memory:')),
        Layer.provide(
          Layer.succeed(EngineFiles)(pathsIn({ data, socketFolder: data })),
        ),
      ),
    )
    const added = yield* Effect.flatMap(Projects, projects =>
      projects.add({
        source: ProjectSource.cases.path.make({ path: checkout }),
        name: Option.some('app'),
      }),
    ).pipe(Effect.provide(services))
    expect(added.id).toBe(project)
    yield* recorded.pipe(Effect.provide(services))
    return yield* RpcTest.makeClient(ReviewRpcs).pipe(Effect.provide(services))
  })

  it.effect(
    'gate.counts answers a ticket, a run, and refuses a project it lacks',
    () =>
      Effect.gen(function* () {
        const client = yield* reviewClient
        const ofTicket = yield* client['gate.counts']({
          project,
          ticket: Option.some(other),
          run: Option.none(),
        })
        expect(ofTicket.map(({ ticket, asked }) => [ticket, asked])).toEqual([
          [other, 1],
        ])
        const ofRun = yield* client['gate.counts']({
          project,
          ticket: Option.none(),
          run: Option.some(later),
        })
        expect(ofRun.map(({ ticket, allowed }) => [ticket, allowed])).toEqual([
          [ticket, 1],
        ])
        const refusal = yield* Effect.flip(
          client['gate.counts']({
            project: ProjectId.make('elsewhere'),
            ticket: Option.none(),
            run: Option.none(),
          }),
        )
        expect(refusal).toBeInstanceOf(ProjectNotFound)
      }).pipe(Effect.scoped),
  )
})
