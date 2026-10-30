import { Duration, Effect, Layer, Metric, Option, Ref, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { RpcTest } from 'effect/rpc'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  ExportFailed,
  InsightsRpcs,
  ModelName,
  ProjectId,
  ProjectNotFound,
  ProviderName,
  Retention as RetentionSetting,
  RunId,
  TicketId,
} from '@fabrica/contracts'

import { EngineFiles, pathsIn } from '../src/engine/paths'
import { Projects } from '../src/projects/service'
import { insightsHandlers } from '../src/rpc/insights'
import {
  Telemetry,
  TelemetryRow,
  makeTelemetry,
  telemetryLayer,
  telemetryStoreLayer,
} from '../src/telemetry'
import { copiedTables } from '../src/telemetry/duckdb'
import {
  isMetadataName,
  isMetadataText,
  metadataOnly,
} from '../src/telemetry/metadata'
import { otlpExportLayer, signalUrl } from '../src/telemetry/otlp'

// Telemetry's export (spec §21, Export): over OTLP to the endpoint the engine's setting names, posted
// to a client that keeps what it is sent, never a network; and on demand as Parquet files, through
// the Insights group. Both carry metadata only, never prompts, paths, secrets or a failure's text;
// nothing is sent while the setting is off.

const project = ProjectId.make('project-1')
const ticket = TicketId.make('fa-a1b2')

const retention = {
  raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
  daily: RetentionSetting.cases.Forever.make({}),
}

/** A model call whose failure is tagged, as the model proxy records it. */
const modelCall = TelemetryRow.ModelCall({
  project,
  run: RunId.make('run-1'),
  ticket,
  provider: ProviderName.make('anthropic'),
  model: ModelName.make('claude-opus-5-5'),
  tokens: { input: 1000, output: 200, cache_write: 0, cache_read: 50 },
  costUsd: 0.25,
  latency: Duration.seconds(4),
  outcome: 'failed',
  error: 'Overloaded',
})

/** Content no export may carry: a prompt, absolute paths, a secret. */
const prompt = 'Build the login page'
const checkout = '/Users/someone/app'
const home = '/home/someone'
const windowsHome = 'C:\\Users\\someone'
const secret = 'hunter2'
const content = [prompt, checkout, home, windowsHome, secret]

/** A posted payload: where it went, and its JSON. */
interface Posted {
  readonly url: string
  readonly json: string
}

/** An HTTP client that answers every post with 200, keeping what it was sent. */
const keeping = (posted: Ref.Ref<ReadonlyArray<Posted>>) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const json =
          request.body._tag === 'Uint8Array'
            ? new TextDecoder().decode(request.body.body)
            : ''
        yield* Ref.update(posted, all => [
          ...all,
          { url: url.toString(), json },
        ])
        return HttpClientResponse.fromWeb(
          request,
          new Response('{}', { status: 200 }),
        )
      }),
    ),
  )

/** Records `modelCall`, runs a span that carries content and fails with it, and counts a metric. */
const work = Effect.gen(function* () {
  const telemetry = yield* Telemetry
  yield* telemetry.record(modelCall)
  yield* Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      prompt,
      'code.filepath': `${checkout}/src/login.ts`,
      worktree: home,
      model: 'claude-opus-5-5',
      tokens: 1200,
      cached: true,
      'url.full': `https://example.com/?token=${secret}`,
    })
    return yield* Effect.fail(
      new Error(`couldn't read ${windowsHome}\\secret.txt: ${secret}`),
    )
  }).pipe(Effect.withSpan('Test.work'), Effect.ignore)
  yield* Metric.update(
    Metric.withAttributes(
      Metric.counter('fabrica_test_exports', { incremental: true }),
      { kind: 'input', folder: checkout },
    ),
    1,
  )
  yield* telemetry.flush
})

/** Runs `work` with the export `endpoint` configures, its scope closed (what is left is sent), and answers what was posted. */
const exportOf = (endpoint: Option.Option<string>) =>
  Effect.gen(function* () {
    const posted = yield* Ref.make<ReadonlyArray<Posted>>([])
    yield* work.pipe(
      Effect.provide(
        otlpExportLayer({ endpoint, version: '1.2.3' }).pipe(
          Layer.provide(keeping(posted)),
          Layer.provideMerge(
            Layer.effect(Telemetry, makeTelemetry({ retention })).pipe(
              Layer.provide(telemetryStoreLayer(':memory:')),
            ),
          ),
        ),
      ),
    )
    return yield* Ref.get(posted)
  })

describe('the OTLP export', () => {
  it.effect('sends spans, metrics and rows, metadata only', () =>
    Effect.gen(function* () {
      const posted = yield* exportOf(Option.some('http://collector:4318/'))
      const sent = (signal: 'traces' | 'metrics' | 'logs') =>
        posted
          .filter(
            ({ url }) => url === signalUrl('http://collector:4318', signal),
          )
          .map(({ json }) => json)
          .join('\n')
      const traces = sent('traces')
      expect(traces).toContain('"Test.work"')
      expect(traces).toContain('"model"')
      expect(traces).toContain('"claude-opus-5-5"')
      expect(traces).toContain('"tokens"')
      expect(traces).toContain('"exception.type"')
      expect(traces).toContain('"fabrica-engine"')
      expect(traces).toContain('"1.2.3"')
      for (const key of ['prompt', 'code.filepath', 'worktree', 'url.full'])
        expect(traces).not.toContain(`"${key}"`)
      expect(traces).not.toContain('exception.message')
      expect(traces).not.toContain('exception.stacktrace')

      const metrics = sent('metrics')
      expect(metrics).toContain('"fabrica_test_exports"')
      expect(metrics).toContain('"kind"')
      expect(metrics).not.toContain('"folder"')

      const rows = JSON.parse(sent('logs'))
      const [record] = rows.resourceLogs[0].scopeLogs[0].logRecords
      expect(record.body).toEqual({ stringValue: 'model_calls' })
      const attributes = Object.fromEntries(
        record.attributes.map(
          ({ key, value }: { key: string; value: unknown }) => [key, value],
        ),
      )
      expect(attributes).toMatchObject({
        project: { stringValue: project },
        ticket: { stringValue: ticket },
        model: { stringValue: 'claude-opus-5-5' },
        input: { intValue: 1000 },
        output: { intValue: 200 },
        cost_usd: { doubleValue: 0.25 },
        latency_ms: { intValue: 4000 },
        error: { stringValue: 'Overloaded' },
      })

      for (const { json } of posted)
        for (const text of content) expect(json).not.toContain(text)
    }),
  )

  it.effect('sends nothing while the setting is off', () =>
    Effect.gen(function* () {
      expect(yield* exportOf(Option.none())).toEqual([])
    }),
  )
})

describe('metadata', () => {
  it('is a number or a flag whatever its name, or short text naming no place', () => {
    expect(
      metadataOnly({
        attributes: [
          { key: 'output', value: { intValue: 200 } },
          { key: 'output', value: { stringValue: 'FAIL a.test.ts' } },
          { key: 'outcome', value: { stringValue: 'merged' } },
          { key: 'cwd', value: { stringValue: 'app' } },
          { key: 'repo', value: { stringValue: '/srv/app' } },
          { key: 'repo', value: { stringValue: '~/app' } },
          { key: 'remote', value: { stringValue: 'ssh://host/app' } },
          { key: 'listing', value: { arrayValue: { values: [] } } },
          { key: 'summary', value: { stringValue: 'x'.repeat(201) } },
        ],
        status: { code: 2, message: `failed at ${checkout}` },
        body: { stringValue: prompt.padEnd(300, '.') },
      }),
    ).toEqual({
      attributes: [
        { key: 'output', value: { intValue: 200 } },
        { key: 'outcome', value: { stringValue: 'merged' } },
      ],
      status: { code: 2 },
    })
    expect(isMetadataText('anthropic/claude-opus-5-5')).toBe(true)
    expect(isMetadataText('see /etc/passwd')).toBe(false)
    expect(isMetadataName('rpc.method')).toBe(true)
    expect(isMetadataName('url.path')).toBe(false)
  })
})

describe('the export on demand', () => {
  /** A client of the Insights handlers on the engine's files in `data`, the engine holding no project. */
  const clientIn = (data: string) =>
    Effect.gen(function* () {
      const paths = pathsIn({ data, socketFolder: data })
      yield* Effect.promise(() => mkdir(data, { recursive: true }))
      const unused = () => Effect.die('not used by an export')
      const projects = Projects.of({
        add: unused,
        list: Effect.succeed([]),
        remove: unused,
        find: id => Effect.fail(new ProjectNotFound({ project: id })),
        setTrusted: unused,
        worktreeHome: unused,
        settings: unused,
        setSettings: unused,
        workGraph: unused,
        onBase: unused,
        watchStatus: () => Stream.die('not used by an export'),
      })
      const services = yield* Layer.build(
        insightsHandlers.pipe(
          Layer.provideMerge(
            telemetryLayer({ filename: paths.telemetry, retention }),
          ),
          Layer.provide(Layer.succeed(Projects)(projects)),
          Layer.provide(Layer.succeed(EngineFiles)(paths)),
        ),
      )
      const telemetry = yield* Telemetry.pipe(Effect.provide(services))
      yield* telemetry.record(modelCall)
      yield* telemetry.flush
      return yield* RpcTest.makeClient(InsightsRpcs).pipe(
        Effect.provide(services),
      )
    })

  const scratch = Effect.acquireRelease(
    Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-export-'))),
    folder =>
      Effect.promise(() => rm(folder, { recursive: true, force: true })),
  )

  it.effect('writes a Parquet file per table in a folder it makes', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const client = yield* clientIn(NodePath.join(root, 'data'))
      const folder = NodePath.join(root, 'exports', 'today')
      const { files } = yield* client['insights.export']({ folder })
      expect(files).toEqual(
        copiedTables.map(table => NodePath.join(folder, `${table}.parquet`)),
      )
      expect((yield* Effect.promise(() => readdir(folder))).toSorted()).toEqual(
        copiedTables.map(table => `${table}.parquet`).toSorted(),
      )
    }),
  )

  it.effect('refuses a folder that isn’t absolute', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const client = yield* clientIn(NodePath.join(root, 'data'))
      const error = yield* Effect.flip(
        client['insights.export']({ folder: 'exports' }),
      )
      expect(error).toBeInstanceOf(ExportFailed)
      expect(error.reason).toContain('absolute path')
    }),
  )
})
