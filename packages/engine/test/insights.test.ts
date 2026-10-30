import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqlClient } from 'effect/sql'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  InsightsQuery,
  InsightsRpcs,
  type InsightsTable,
  ModelName,
  ProjectId,
  ProjectInfo,
  ProjectNotFound,
  ProviderName,
  Retention as RetentionSetting,
  RunId,
  Ticket,
  TicketId,
} from '@fabrica/contracts'

import { sessionFolder } from '../src/agent/launch'
import { EngineFiles, type EnginePaths, pathsIn } from '../src/engine/paths'
import { Projects, WorkGraphUnopened } from '../src/projects/service'
import { engineQueryLayer, insightsHandlersOn } from '../src/rpc/insights'
import { eventsPath } from '../src/runlog'
import { Telemetry, TelemetryRow, makeTelemetry } from '../src/telemetry'
import {
  TelemetryStore,
  telemetryLayer,
  telemetryStoreLayer,
} from '../src/telemetry'
import {
  QueryLayerFailed,
  TelemetryDb,
  copiedTables,
  telemetryDbLayer,
} from '../src/telemetry/duckdb'
import { isMetadataName } from '../src/telemetry/metadata'
import {
  type Sources,
  findEventStream,
  findSessionFiles,
  readSummary,
  runNamedQuery,
} from '../src/telemetry/queries'

// The telemetry query layer (spec §21, H65): an in-memory DuckDB over the recorded rows (copied from
// an in-memory telemetry store), a project's event stream and Pi's session files, read in place.
// Each named query runs over the same fixture; an export carries the recorded rows' metadata alone.

const project = ProjectId.make('project-1')
const run = RunId.make('run-1')
const first = TicketId.make('fa-a1b2')
const second = TicketId.make('fa-c3d4')
const opus = ModelName.make('claude-opus-5-5')
const gpt = ModelName.make('gpt-5')

/** A folder of the test's own, removed as its scope closes. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-insights-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const write = (path: string, lines: ReadonlyArray<unknown>) =>
  Effect.promise(async () => {
    await mkdir(NodePath.dirname(path), { recursive: true })
    await writeFile(
      path,
      lines
        .map(line => (typeof line === 'string' ? line : JSON.stringify(line)))
        .join('\n') + '\n',
    )
  })

/** A record of the run's stream, at `clock` (local time, +02:00). */
const record = (
  clock: string,
  kind: string,
  fields: Readonly<Record<string, unknown>> = {},
) => ({ v: 1, time: `2026-10-29T${clock}.000+02:00`, run, kind, ...fields })

const tokens = (input: number, output: number) => ({
  input,
  output,
  cache_write: 0,
  cache_read: 10,
})

/** The run's stream: two tickets, one merged after a question and a flaky check, one set aside. */
const events = [
  record('10:00:00', 'start', {
    version: '1.0.0',
    engine: 'engine-1',
    repo: 'r',
    branch: 'main',
    commit: 'c0ffee0',
    concurrency: 2,
  }),
  record('10:01:00', 'check', {
    suite: 'merge',
    ticket: first,
    command: 'pnpm test',
    commit: 'abc1234',
    seconds: 30,
    result: 'failed',
    output: 'FAIL a.test.ts\nFLAKY: a.test.ts > adds\n',
  }),
  record('10:02:00', 'check', {
    suite: 'merge',
    ticket: first,
    command: 'pnpm test',
    commit: 'abc1234',
    seconds: 20,
    result: 'passed',
  }),
  record('10:05:00', 'asked', {
    ticket: first,
    title: 'First',
    question: 'fa-q1',
    detail: 'fa-q1 Which?',
    text: 'asked',
  }),
  record('10:15:00', 'answered', {
    ticket: first,
    title: 'First',
    question: 'fa-q1',
    detail: 'answered',
    text: 'answered',
  }),
  record('10:20:00', 'asked', {
    ticket: second,
    title: 'Second',
    question: 'fa-q2',
    detail: 'fa-q2 What?',
    text: 'asked',
  }),
  record('10:30:00', 'closed', {
    ticket: first,
    title: 'First',
    commit: 'abc1234',
    detail: 'abc1234 merged into main',
    text: 'closed',
  }),
  record('10:30:00', 'ticket_end', {
    ticket: first,
    outcome: 'merged',
    phase: 'merged',
    seconds: 1800,
    phases: { working: 600, waiting: 600, merging: 120 },
    hand_backs: { resolve: 0, fix: 1 },
  }),
  record('10:40:00', 'deferred', {
    ticket: second,
    title: 'Second',
    reason: 'DEFERRED',
    detail: 'deferred',
    text: 'deferred',
  }),
  record('10:40:00', 'ticket_end', {
    ticket: second,
    outcome: 'set_aside',
    phase: 'set_aside',
    seconds: 600,
  }),
  record('10:41:00', 'turn', {
    ticket: first,
    session: 's-1',
    model: opus,
    tokens: { [opus]: tokens(100, 50) },
    cost_usd: 0.5,
    turns: 3,
    duration_ms: 1000,
  }),
  record('10:42:00', 'turn', {
    ticket: second,
    session: 's-2',
    model: opus,
    tokens: { [opus]: tokens(40, 10) },
    cost_usd: 0.25,
    turns: 1,
    duration_ms: 500,
  }),
  record('10:50:00', 'end', { code: 0, cost_usd: 0.75 }),
  // A line cut short and a record of a later format: passed over.
  '{"v":1,"time":"2026-10-29T10:51',
  { ...record('10:52:00', 'start'), v: 2 },
]

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens: input + output + 60,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})

/** A session of the first ticket's on opus, with a cache warm-up; the second's on gpt-5. */
const firstSession = [
  {
    type: 'session',
    version: 3,
    id: 's-1',
    timestamp: '2026-10-29T08:02:00.000Z',
    cwd: '/work',
  },
  {
    type: 'message',
    id: 'a1',
    parentId: null,
    timestamp: '2026-10-29T08:02:01.000Z',
    message: { role: 'user', content: 'Build it', timestamp: 1 },
  },
  {
    type: 'message',
    id: 'a2',
    parentId: 'a1',
    timestamp: '2026-10-29T08:02:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      provider: 'anthropic',
      model: opus,
      usage: usage(1000, 200, 0.12),
      stopReason: 'stop',
      timestamp: 2,
    },
  },
  {
    type: 'usage',
    id: 'a3',
    parentId: 'a2',
    timestamp: '2026-10-29T08:02:03.000Z',
    kind: 'cache_warm',
    provider: 'anthropic',
    model: opus,
    usage: usage(0, 0, 0.01),
  },
]

const secondSession = [
  {
    type: 'message',
    id: 'b1',
    parentId: null,
    timestamp: '2026-10-29T08:21:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Thinking' }],
      provider: 'openai',
      model: gpt,
      usage: usage(300, 30, 0.03),
      timestamp: 3,
    },
  },
]

/** The rows the engine recorded over the run. */
const rows = [
  TelemetryRow.Check({
    project,
    run,
    ticket: first,
    suite: 'merge',
    duration: Duration.seconds(30),
    result: 'failed',
  }),
  TelemetryRow.Check({
    project,
    run,
    ticket: first,
    suite: 'merge',
    duration: Duration.seconds(20),
    result: 'passed',
  }),
  TelemetryRow.Check({
    project,
    run,
    ticket: second,
    suite: 'own',
    duration: Duration.seconds(10),
    result: 'passed',
  }),
  TelemetryRow.Hold({
    project,
    run,
    ticket: first,
    hold: 'USAGE_LIMIT',
    duration: Duration.minutes(1),
  }),
  TelemetryRow.ToolCall({
    project,
    run,
    ticket: first,
    tool: 'bash',
    duration: Duration.seconds(5),
    allowed: true,
    asked: true,
  }),
  TelemetryRow.ToolCall({
    project,
    run,
    ticket: first,
    tool: 'bash',
    duration: Duration.seconds(15),
    allowed: false,
    asked: true,
  }),
  TelemetryRow.ToolCall({
    project,
    run,
    ticket: first,
    tool: 'read',
    duration: Duration.millis(3),
    allowed: true,
    asked: false,
  }),
  TelemetryRow.Merge({
    project,
    run,
    ticket: first,
    duration: Duration.seconds(40),
    outcome: 'merged',
  }),
  TelemetryRow.Merge({
    project,
    run,
    ticket: second,
    duration: Duration.seconds(25),
    outcome: 'CHECKS_FAILED',
  }),
  TelemetryRow.HandBack({ project, run, ticket: first, kind: 'fix' }),
  TelemetryRow.WorkerSession({
    project,
    run,
    ticket: first,
    model: opus,
    duration: Duration.seconds(100),
    outcome: 'finish',
  }),
  TelemetryRow.WorkerSession({
    project,
    run,
    ticket: second,
    model: gpt,
    duration: Duration.seconds(50),
    outcome: 'defer',
  }),
  TelemetryRow.ModelCall({
    project,
    run,
    ticket: first,
    provider: ProviderName.make('anthropic'),
    model: opus,
    tokens: tokens(100, 50),
    costUsd: 0.5,
    latency: Duration.seconds(4),
    outcome: 'failed',
    error: 'Overloaded',
  }),
]

const ticketOf = (id: TicketId, type: Ticket['type']) =>
  new Ticket({
    id,
    type,
    title: `The secret title of ${id}`,
    description: Option.some('Secret description'),
    design: Option.none(),
    acceptance: Option.none(),
    status: 'open',
    resolution: Option.none(),
    priority: 2,
    deferUntil: Option.none(),
    assignee: Option.none(),
    model: Option.none(),
    metadata: {
      files: Option.none(),
      spec: Option.none(),
      predicted_files: Option.none(),
      result_kind: Option.none(),
    },
    result: Option.none(),
    question: Option.none(),
    mergedCommit: Option.none(),
    closeReason: Option.none(),
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  })

const tickets = [
  {
    project,
    tickets: [ticketOf(first, 'feature'), ticketOf(second, 'bug')],
  },
]

const retention = {
  raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
  daily: RetentionSetting.cases.Forever.make({}),
}

/** Telemetry and the query layer, each in memory, the store's client beside them. */
const queryLayer = Layer.mergeAll(
  Layer.effect(Telemetry, makeTelemetry({ retention })),
  telemetryDbLayer(':memory:'),
).pipe(Layer.provideMerge(telemetryStoreLayer(':memory:')))

/** Records the rows, writes the fixture's files, refreshes the copies; the sources found. */
const fixture = Effect.gen(function* () {
  const root = yield* scratch
  const checkout = NodePath.join(root, 'checkout')
  const data = NodePath.join(root, 'data')
  yield* write(NodePath.join(checkout, eventsPath), events)
  yield* write(
    NodePath.join(
      sessionFolder({ data, project, ticket: first }),
      '2026-10-29_s-1.jsonl',
    ),
    firstSession,
  )
  yield* write(
    NodePath.join(
      sessionFolder({ data, project, ticket: second }),
      '2026-10-29_s-2.jsonl',
    ),
    secondSession,
  )
  const telemetry = yield* Telemetry
  for (const row of rows) yield* telemetry.record(row)
  yield* telemetry.flush
  yield* (yield* TelemetryDb).refresh(tickets)
  const stream = yield* findEventStream(checkout)
  const sessions = yield* findSessionFiles({ data, project })
  const sources: Sources = {
    events: Option.match(stream, {
      onNone: () => [],
      onSome: file => [{ project, file }],
    }),
    sessions,
  }
  return { root, checkout, data, sources }
})

/** The table's rows, each by its column names. */
const recordsOf = (table: InsightsTable) =>
  table.rows.map(row =>
    Object.fromEntries(
      table.columns.map((column, index) => [
        column.name,
        Option.getOrNull(row[index] ?? Option.none()),
      ]),
    ),
  )

const query = (named: InsightsQuery, sources: Sources) =>
  runNamedQuery(named, sources).pipe(Effect.map(recordsOf))

describe('the named queries', () => {
  it.effect('find the stream and the session files where they lie', () =>
    Effect.gen(function* () {
      const { sources, checkout, data } = yield* fixture
      expect(sources.events).toEqual([
        { project, file: NodePath.join(checkout, eventsPath) },
      ])
      expect(sources.sessions.map(({ ticket }) => ticket)).toEqual([
        first,
        second,
      ])
      expect(sources.sessions[0]?.file).toBe(
        NodePath.join(
          sessionFolder({ data, project, ticket: first }),
          '2026-10-29_s-1.jsonl',
        ),
      )
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('passes over a stream planted as a link', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const checkout = NodePath.join(root, 'checkout')
      const elsewhere = NodePath.join(root, 'elsewhere.jsonl')
      yield* write(elsewhere, events)
      yield* Effect.promise(async () => {
        await mkdir(NodePath.dirname(NodePath.join(checkout, eventsPath)), {
          recursive: true,
        })
        await symlink(elsewhere, NodePath.join(checkout, eventsPath))
      })
      expect(yield* findEventStream(checkout)).toEqual(Option.none())
      expect(yield* findEventStream(NodePath.join(root, 'none'))).toEqual(
        Option.none(),
      )
    }),
  )

  it.effect('where a ticket’s time goes', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      const parts = yield* query(
        InsightsQuery.cases.ticket_time.make({
          project,
          ticket: Option.some(first),
          run: Option.none(),
        }),
        sources,
      )
      expect(parts).toEqual([
        { run, ticket: first, part: 'check:merge', millis: 50_000, count: 2 },
        { run, ticket: first, part: 'hand_back:fix', millis: null, count: 1 },
        {
          run,
          ticket: first,
          part: 'hand_back:resolve',
          millis: null,
          count: 0,
        },
        {
          run,
          ticket: first,
          part: 'hold:USAGE_LIMIT',
          millis: 60_000,
          count: 1,
        },
        {
          run,
          ticket: first,
          part: 'phase:merging',
          millis: 120_000,
          count: null,
        },
        {
          run,
          ticket: first,
          part: 'phase:waiting',
          millis: 600_000,
          count: null,
        },
        {
          run,
          ticket: first,
          part: 'phase:working',
          millis: 600_000,
          count: null,
        },
        { run, ticket: first, part: 'question', millis: 600_000, count: 1 },
        { run, ticket: first, part: 'total', millis: 1_800_000, count: null },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('the waits of questions and permission requests', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.waits.make({
            project: Option.some(project),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        {
          wait: 'permission',
          asked: 2,
          median: 10_000,
          longest: 15_000,
          waiting: 0,
        },
        {
          wait: 'question',
          asked: 2,
          median: 600_000,
          longest: 600_000,
          waiting: 1,
        },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('check durations by suite', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.check_durations.make({
            project: Option.none(),
            suite: Option.none(),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        {
          suite: 'merge',
          checks: 2,
          failed: 1,
          median: 25_000,
          p90: 29_000,
          longest: 30_000,
        },
        {
          suite: 'own',
          checks: 1,
          failed: 0,
          median: 10_000,
          p90: 10_000,
          longest: 10_000,
        },
      ])
      expect(
        yield* query(
          InsightsQuery.cases.check_durations.make({
            project: Option.some(project),
            suite: Option.some('own'),
            since: Option.none(),
          }),
          sources,
        ),
      ).toHaveLength(1)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('flaky tests, by test', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.flaky_tests.make({
            project: Option.none(),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        {
          test: 'a.test.ts > adds',
          times: 1,
          last: Date.UTC(2026, 9, 29, 8, 1),
        },
        { test: 'pnpm test', times: 1, last: Date.UTC(2026, 9, 29, 8, 2) },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('cost per merged ticket, by run', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.cost_per_merged_ticket.make({
            project: Option.none(),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        {
          run,
          started: Date.UTC(2026, 9, 29, 8, 0),
          merged: 1,
          cost: 0.75,
          cost_per_merged: 0.75,
        },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('tokens by model, by run from the stream', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.tokens_by_model.make({
            project: Option.none(),
            since: Option.none(),
            by: 'run',
          }),
          sources,
        ),
      ).toEqual([
        {
          run,
          model: opus,
          input: 140,
          output: 60,
          cache_write: 0,
          cache_read: 20,
          cost: 0.75,
        },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('tokens by model, by ticket from the session files', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.tokens_by_model.make({
            project: Option.none(),
            since: Option.none(),
            by: 'ticket',
          }),
          sources,
        ),
      ).toEqual([
        {
          ticket: first,
          model: opus,
          input: 1000,
          output: 200,
          cache_write: 20,
          cache_read: 100,
          cost: 0.13,
        },
        {
          ticket: second,
          model: gpt,
          input: 300,
          output: 30,
          cache_write: 10,
          cache_read: 50,
          cost: 0.03,
        },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('hand-back and set-aside rates', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.hand_back_rates.make({
            project: Option.none(),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        { outcome: 'hand_back:fix', tickets: 1, share: 0.5 },
        { outcome: 'hand_back:resolve', tickets: 0, share: 0 },
        { outcome: 'merged', tickets: 1, share: 0.5 },
        { outcome: 'set_aside', tickets: 1, share: 0.5 },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('models compared on tickets of a type', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      expect(
        yield* query(
          InsightsQuery.cases.models_compared.make({
            project: Option.none(),
            since: Option.none(),
          }),
          sources,
        ),
      ).toEqual([
        {
          type: 'bug',
          model: gpt,
          tickets: 1,
          finished: 0,
          median: 50_000,
          tokens_per_ticket: 390,
          cost_per_ticket: 0.03,
        },
        {
          type: 'feature',
          model: opus,
          tickets: 1,
          finished: 1,
          median: 100_000,
          tokens_per_ticket: 1320,
          cost_per_ticket: 0.13,
        },
      ])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('a query from a time leaves out what came before it', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      const later = Option.some(DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 9)))
      expect(
        yield* query(
          InsightsQuery.cases.cost_per_merged_ticket.make({
            project: Option.none(),
            since: later,
          }),
          sources,
        ),
      ).toEqual([])
      expect(
        yield* query(
          InsightsQuery.cases.tokens_by_model.make({
            project: Option.none(),
            since: later,
            by: 'project',
          }),
          sources,
        ),
      ).toEqual([])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect(
    'a query with no stream and no sessions answers from the rows',
    () =>
      Effect.gen(function* () {
        yield* fixture
        const none: Sources = { events: [], sessions: [] }
        expect(
          yield* query(
            InsightsQuery.cases.waits.make({
              project: Option.none(),
              since: Option.none(),
            }),
            none,
          ),
        ).toEqual([
          {
            wait: 'permission',
            asked: 2,
            median: 10_000,
            longest: 15_000,
            waiting: 0,
          },
          {
            wait: 'question',
            asked: 0,
            median: null,
            longest: null,
            waiting: 0,
          },
        ])
      }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('the summary', () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture
      const summary = yield* readSummary(
        { project: Option.some(project), since: Option.none() },
        sources,
      )
      expect(summary.runs).toBe(1)
      expect(summary.merged).toBe(1)
      expect(summary.setAside).toBe(1)
      expect(summary.handBacks).toEqual({ resolve: 0, fix: 1 })
      expect(summary.tokens).toEqual({
        [opus]: { input: 1000, output: 200, cache_write: 20, cache_read: 100 },
        [gpt]: { input: 300, output: 30, cache_write: 10, cache_read: 50 },
      })
      expect(Option.map(summary.costUsd, cost => cost.toFixed(2))).toEqual(
        Option.some('0.16'),
      )
      expect(summary.readyToMerged).toEqual(Option.some(1_800_000))
    }).pipe(Effect.provide(queryLayer)),
  )
})

describe('the copies of the recorded rows', () => {
  const countIn = (table: string) =>
    Effect.gen(function* () {
      const [row] = yield* (yield* TelemetryDb).rows(
        `SELECT count(*) AS count FROM ${table}`,
      )
      return row?.count
    })

  it.effect('a refresh appends what was recorded since, once', () =>
    Effect.gen(function* () {
      yield* fixture
      const db = yield* TelemetryDb
      expect(yield* countIn('checks')).toBe(3)
      yield* db.refresh([])
      expect(yield* countIn('checks')).toBe(3)
      const telemetry = yield* Telemetry
      yield* telemetry.record(
        rows[0] ?? TelemetryRow.HostSample({ load: 1, cores: 1 }),
      )
      yield* telemetry.flush
      yield* db.refresh([])
      expect(yield* countIn('checks')).toBe(4)
      expect(yield* countIn('tickets')).toBe(2)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect(
    'drops the copies of rows retention dropped, and copies a store made anew whole',
    () =>
      Effect.gen(function* () {
        yield* fixture
        const db = yield* TelemetryDb
        const sql = yield* SqlClient.SqlClient
        const sample = (at: number) =>
          sql`INSERT INTO host_samples (at, load, cores) VALUES (${at}, 1, 4)`
        const copiedAts = db
          .rows(`SELECT "at" FROM host_samples ORDER BY "at"`)
          .pipe(Effect.map(found => found.map(row => row.at)))
        yield* sample(100)
        yield* sample(200)
        yield* sample(300)
        yield* db.refresh([])
        expect(yield* copiedAts).toEqual([100, 200, 300])
        // Retention drops every row before a cutoff; one more is recorded.
        yield* sql`DELETE FROM host_samples WHERE at < 200`
        yield* sample(400)
        yield* db.refresh([])
        expect(yield* copiedAts).toEqual([200, 300, 400])
        // Every row gone and new ones written: the rowids start again.
        yield* sql`DELETE FROM checks`
        yield* sql`INSERT INTO checks (at, project, suite, duration_ms, result) VALUES (1, 'p', 'own', 5, 'passed')`
        yield* db.refresh([])
        const copied = yield* db.rows(`SELECT project, duration_ms FROM checks`)
        expect(copied).toEqual([{ project: 'p', duration_ms: 5 }])
      }).pipe(Effect.provide(queryLayer)),
  )
})

describe('the query layer’s database', () => {
  it.effect('pins its storage version and loads nothing at run time', () =>
    Effect.gen(function* () {
      const db = yield* TelemetryDb
      expect(
        yield* db.rows(
          `SELECT current_setting('storage_compatibility_version') AS storage,
             current_setting('autoinstall_known_extensions') AS install,
             current_setting('autoload_known_extensions') AS load`,
        ),
      ).toEqual([{ storage: 'v1.5.0', install: 0, load: 0 }])
      expect(
        yield* db.rows(
          `SELECT install_mode FROM duckdb_extensions() WHERE extension_name = 'json'`,
        ),
      ).toEqual([{ install_mode: 'STATICALLY_LINKED' }])
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('a file it made is opened again with its copies', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const file = NodePath.join(root, 'telemetry.duckdb')
      const store = telemetryStoreLayer(NodePath.join(root, 'telemetry.db'))
      yield* Effect.gen(function* () {
        const telemetry = yield* Telemetry
        for (const row of rows) yield* telemetry.record(row)
        yield* telemetry.flush
        yield* (yield* TelemetryDb).refresh([])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.effect(Telemetry, makeTelemetry({ retention })),
            telemetryDbLayer(file),
          ).pipe(Layer.provideMerge(store)),
        ),
      )
      const copied = yield* Effect.gen(function* () {
        const db = yield* TelemetryDb
        const [row] = yield* db.rows(`SELECT count(*) AS count FROM checks`)
        yield* db.refresh([])
        const [again] = yield* db.rows(`SELECT count(*) AS count FROM checks`)
        return [row?.count, again?.count]
      }).pipe(Effect.provide(telemetryDbLayer(file).pipe(Layer.provide(store))))
      expect(copied).toEqual([3, 3])
    }),
  )
})

describe('an export', () => {
  it.effect('carries the recorded rows’ metadata, never content', () =>
    Effect.gen(function* () {
      const { root } = yield* fixture
      const db = yield* TelemetryDb
      const folder = NodePath.join(root, 'export')
      yield* Effect.promise(() => mkdir(folder))
      const files = yield* db.exportParquet(folder)
      expect(files.map(file => NodePath.basename(file, '.parquet'))).toEqual(
        copiedTables,
      )
      for (const file of files) {
        const columns = yield* db.rows(
          `SELECT name, type FROM parquet_schema($file) WHERE num_children IS NULL`,
          { file },
        )
        const names = columns.map(({ name }) => String(name))
        expect(names).not.toContain('source_row')
        // Every column recorded today is metadata: none is left out (the daily aggregates' key with them).
        const recorded = yield* db.rows(
          `SELECT column_name AS name FROM duckdb_columns() WHERE table_name = $table AND column_name <> 'source_row' ORDER BY column_index`,
          { table: NodePath.basename(file, '.parquet') },
        )
        expect(names).toEqual(recorded.map(({ name }) => String(name)))
        // Text is never named as content; a number named so is a count (a model call's tokens out).
        for (const { name, type } of columns)
          if (type === 'BYTE_ARRAY')
            expect(isMetadataName(String(name))).toBe(true)
      }
      const [calls] = yield* db.rows(
        `SELECT count(*) AS count, max(error) AS error, sum(output) AS output FROM read_parquet($file)`,
        { file: NodePath.join(folder, 'model_calls.parquet') },
      )
      expect(calls).toEqual({ count: 1, error: 'Overloaded', output: 50 })
      // The tickets' text never reaches an export, nor do the session files' prompts.
      for (const file of files) {
        const exported = yield* db.rows(`SELECT * FROM read_parquet($file)`, {
          file,
        })
        expect(JSON.stringify(exported)).not.toMatch(/secret|Build it|Done/iu)
      }
    }).pipe(Effect.provide(queryLayer)),
  )
})

describe('the Insights group', () => {
  /** The project `app` at `checkout`, its work graph unopened: queried without its tickets. */
  const projectsAt = (checkout: string) => {
    const info = new ProjectInfo({
      id: project,
      name: 'app',
      path: checkout,
      origin: 'registered',
      url: Option.none(),
      base: 'main',
      setUp: true,
      trusted: false,
    })
    const unused = () => Effect.die('not used by the Insights group')
    return Projects.of({
      add: unused,
      list: Effect.succeed([info]),
      remove: unused,
      find: id =>
        id === project
          ? Effect.succeed({ ...info, trusted: false })
          : Effect.fail(new ProjectNotFound({ project: id })),
      setTrusted: unused,
      worktreeHome: unused,
      settings: unused,
      setSettings: unused,
      workGraph: id =>
        Effect.fail(
          new WorkGraphUnopened({ project: id, reason: 'none here' }),
        ),
      onBase: unused,
      watchStatus: () => Stream.die('not used by the Insights group'),
    })
  }

  /**
   * A client of the handlers, the engine's files in `data`, the project's checkout `checkout`, its
   * telemetry store opened as the daemon opens it.
   */
  const clientOf = (options: {
    readonly data: string
    readonly checkout: string
    readonly database?: (
      files: EnginePaths,
    ) => Layer.Layer<TelemetryDb, unknown, TelemetryStore>
  }) =>
    Effect.gen(function* () {
      const paths = pathsIn({ data: options.data, socketFolder: options.data })
      const services = yield* Layer.build(
        insightsHandlersOn(options.database ?? engineQueryLayer).pipe(
          Layer.provide(Layer.succeed(Projects)(projectsAt(options.checkout))),
          Layer.provide(Layer.succeed(EngineFiles)(paths)),
          Layer.provide(
            telemetryLayer({ filename: paths.telemetry, retention }),
          ),
        ),
      )
      return yield* RpcTest.makeClient(InsightsRpcs).pipe(
        Effect.provide(services),
      )
    })

  /** The fixture's stream and sessions, and its rows recorded in the engine's telemetry store. */
  const engineFixture = Effect.gen(function* () {
    const root = yield* scratch
    const checkout = NodePath.join(root, 'checkout')
    const data = NodePath.join(root, 'data')
    yield* write(NodePath.join(checkout, eventsPath), events)
    yield* write(
      NodePath.join(
        sessionFolder({ data, project, ticket: first }),
        '2026-10-29_s-1.jsonl',
      ),
      firstSession,
    )
    const paths = pathsIn({ data, socketFolder: data })
    yield* Effect.gen(function* () {
      const telemetry = yield* Telemetry
      for (const row of rows) yield* telemetry.record(row)
      yield* telemetry.flush
    }).pipe(
      Effect.provide(
        Layer.effect(Telemetry, makeTelemetry({ retention })).pipe(
          Layer.provide(telemetryStoreLayer(paths.telemetry)),
        ),
      ),
    )
    return { checkout, data }
  })

  it.effect(
    'answers a named query and the summary from the engine’s files',
    () =>
      Effect.gen(function* () {
        const { checkout, data } = yield* engineFixture
        const client = yield* clientOf({ data, checkout })
        const table = yield* client['insights.query']({
          query: InsightsQuery.cases.check_durations.make({
            project: Option.some(project),
            suite: Option.some('merge'),
            since: Option.none(),
          }),
        })
        expect(recordsOf(table)).toEqual([
          {
            suite: 'merge',
            checks: 2,
            failed: 1,
            median: 25_000,
            p90: 29_000,
            longest: 30_000,
          },
        ])
        const summary = yield* client['insights.summary']({
          project: Option.none(),
          since: Option.none(),
        })
        expect(summary.merged).toBe(1)
        expect(summary.tokens).toEqual({
          [opus]: {
            input: 1000,
            output: 200,
            cache_write: 20,
            cache_read: 100,
          },
        })
      }),
  )

  it.effect('refuses a project the engine doesn’t have', () =>
    Effect.gen(function* () {
      const { checkout, data } = yield* engineFixture
      const client = yield* clientOf({ data, checkout })
      const other = ProjectId.make('other')
      const exit = yield* Effect.exit(
        client['insights.summary']({
          project: Option.some(other),
          since: Option.none(),
        }),
      )
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(new ProjectNotFound({ project: other })),
      )
    }),
  )

  it.effect(
    'answers each request with the reason where DuckDB can’t open',
    () =>
      Effect.gen(function* () {
        const { checkout, data } = yield* engineFixture
        const client = yield* clientOf({
          data,
          checkout,
          database: () =>
            Layer.effect(
              TelemetryDb,
              Effect.fail(
                new QueryLayerFailed({
                  reason: "DuckDB can't be loaded on this host",
                }),
              ),
            ),
        })
        for (let request = 0; request < 2; request += 1) {
          const exit = yield* Effect.exit(
            client['insights.query']({
              query: InsightsQuery.cases.hand_back_rates.make({
                project: Option.none(),
                since: Option.none(),
              }),
            }),
          )
          expect(
            Exit.isFailure(exit) &&
              Cause.pretty(exit.cause).includes(
                "DuckDB can't be loaded on this host",
              ),
          ).toBe(true)
        }
      }),
  )
})
