import {
  Clock,
  ConfigProvider,
  type Duration,
  Effect,
  Layer,
  Option,
} from 'effect'
import type { HttpClient } from 'effect/http'
import {
  OtlpExporter,
  OtlpMetrics,
  OtlpResource,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability'

import { metadataSerialization } from './metadata'
import { type TelemetryRow, columnsOf, rowTables } from './rows'
import { Telemetry } from './service'

// Telemetry's OTLP export (spec §21, Export): off by default; where the engine's
// `telemetry.otlp_endpoint` names an OTLP/HTTP endpoint, Effect's spans and metrics
// (`effect/observability`, @effect/opentelemetry's OTLP exporters as Effect 4 ships them) and the
// recorded rows, as log records, one per row, its table the body and its columns the attributes, are
// posted below it, every payload metadata only (`metadataSerialization`). Nothing is sent, and no
// HTTP client is used, while the setting is off. The exporters read no OpenTelemetry environment
// variables: the setting is the one place the export is configured. They batch, retry, pause after
// failures and send what is left as their scope closes, as Effect's do.

export interface OtlpExportOptions {
  /** The engine's `telemetry.otlp_endpoint`; none: nothing is sent. */
  readonly endpoint: Option.Option<string>
  /** The engine's release, as the export's resource names it. */
  readonly version: string
  /** How often batches are posted; Effect's (5 seconds for spans and rows, 10 for metrics) where left out. */
  readonly exportInterval?: Duration.Input
}

/** The URL below `endpoint` a signal is posted to: `/v1/traces`, `/v1/metrics` or `/v1/logs`. */
export const signalUrl = (
  endpoint: string,
  signal: 'traces' | 'metrics' | 'logs',
): string => `${endpoint.replace(/\/+$/u, '')}/v1/${signal}`

/** A recorded row as an OTLP log record: its table the body, its columns but its time the attributes. */
const logRecordOf = (row: TelemetryRow, at: number) => {
  const time = String(BigInt(at) * 1_000_000n)
  return {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: rowTables[row._tag] },
    attributes: OtlpResource.entriesToAttributes(
      Object.entries(columnsOf(row, at)).filter(
        ([name, value]) => name !== 'at' && value !== null,
      ),
    ),
    droppedAttributesCount: 0,
  }
}

/** Telemetry that also sends each row it records over OTLP to `url`. */
const rowsExport = (options: {
  readonly url: string
  readonly resource: OtlpResource.Resource
  readonly exportInterval: Duration.Input
}) =>
  Layer.effect(
    Telemetry,
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const exporter = yield* OtlpExporter.make({
        label: 'TelemetryRows',
        url: options.url,
        headers: undefined,
        exportInterval: options.exportInterval,
        maxBatchSize: 1000,
        body: logRecords => [
          serialization.logs({
            resourceLogs: [
              {
                resource: options.resource,
                scopeLogs: [
                  { scope: { name: 'fabrica.telemetry' }, logRecords },
                ],
              },
            ],
          }),
          Effect.void,
        ],
        shutdownTimeout: '3 seconds',
      })
      const record = (row: TelemetryRow) =>
        telemetry.record(row).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap(at =>
            Effect.sync(() => exporter.push(logRecordOf(row, at))),
          ),
        )
      return Telemetry.of({ record, flush: telemetry.flush })
    }),
  )

/**
 * The export `options` configure, on the Telemetry in context: where an endpoint is given, a Tracer
 * and a metrics exporter for everything run in the layer's context, and Telemetry that sends each row
 * as well as recording it; where none is, the Telemetry in context, and nothing else.
 */
export const otlpExportLayer = (
  options: OtlpExportOptions,
): Layer.Layer<Telemetry, never, Telemetry | HttpClient.HttpClient> =>
  Option.match(options.endpoint, {
    onNone: () => Layer.effect(Telemetry, Effect.service(Telemetry)),
    onSome: endpoint => {
      const resource = {
        serviceName: 'fabrica-engine',
        serviceVersion: options.version,
      }
      return Layer.mergeAll(
        OtlpTracer.layer({
          url: signalUrl(endpoint, 'traces'),
          resource,
          exportInterval: options.exportInterval,
        }),
        OtlpMetrics.layer({
          url: signalUrl(endpoint, 'metrics'),
          resource,
          exportInterval: options.exportInterval,
        }),
        rowsExport({
          url: signalUrl(endpoint, 'logs'),
          resource: OtlpResource.make(resource),
          exportInterval: options.exportInterval ?? '5 seconds',
        }).pipe(Layer.provide(OtlpExporter.layerFlusher)),
      ).pipe(
        Layer.provide(metadataSerialization),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
    },
  })
