import { Duration, Effect, Metric } from 'effect'

import { TelemetryRow } from './rows'

// The engine's metrics (spec §21, Instrumentation): counters and histograms updated as rows are
// recorded, one place for each row's, and the telemetry writer's own. They live in Effect's metric
// registry; nothing exports them until an export is configured (§21, Export, off by default).

/** Histogram boundaries in milliseconds, from 10 ms to about 3 hours. */
const millisBoundaries = Metric.exponentialBoundaries({
  start: 10,
  factor: 4,
  count: 10,
})

const modelCalls = Metric.counter('fabrica_model_calls', {
  description: 'Model calls through the model proxy',
  incremental: true,
})
const modelTokens = Metric.counter('fabrica_model_tokens', {
  description: 'Tokens of model calls, by kind',
  incremental: true,
})
const modelLatency = Metric.histogram('fabrica_model_latency_ms', {
  description: 'Model calls, from request to last token',
  boundaries: millisBoundaries,
})
const toolCalls = Metric.histogram('fabrica_tool_call_ms', {
  description: "Tool calls, by the gate's decision",
  boundaries: millisBoundaries,
})
const checks = Metric.histogram('fabrica_check_ms', {
  description: 'Checks and setups, by suite and result',
  boundaries: millisBoundaries,
})
const merges = Metric.histogram('fabrica_merge_ms', {
  description: 'Merge turns, by outcome',
  boundaries: millisBoundaries,
})
const handBacks = Metric.counter('fabrica_hand_backs', {
  description: 'Hand-backs, by kind',
  incremental: true,
})
const holds = Metric.histogram('fabrica_hold_ms', {
  description: 'Holds, by kind, recorded as they lift',
  boundaries: millisBoundaries,
})
const workerSessions = Metric.histogram('fabrica_worker_session_ms', {
  description: 'Worker sessions, by outcome',
  boundaries: millisBoundaries,
})
const organCalls = Metric.histogram('fabrica_organ_call_ms', {
  description: 'Organ calls, by organ and outcome',
  boundaries: millisBoundaries,
})
const hostLoad = Metric.gauge('fabrica_host_load_per_core', {
  description: "The host's 1-minute load per core",
})
const processRss = Metric.gauge('fabrica_process_rss_bytes', {
  description: "A worker's or a check's process tree's resident memory",
})

/** Batches the telemetry writer wrote. */
export const batchesWritten = Metric.counter('fabrica_telemetry_batches', {
  description: 'Batches of telemetry rows written',
  incremental: true,
})

/** Rows telemetry lost: its queue full, its store closed, or their batch's write failed. */
export const rowsLost = Metric.counter('fabrica_telemetry_rows_lost', {
  description: 'Telemetry rows lost before they were written',
  incremental: true,
})

/** Retention prunes the telemetry writer ran. */
export const prunesRun = Metric.counter('fabrica_telemetry_prunes', {
  description: 'Retention prunes of telemetry rows',
  incremental: true,
})

const millis = (duration: Duration.Duration) => Duration.toMillis(duration)

/** Updates the metrics a recorded row counts in. */
export const observe = (row: TelemetryRow): Effect.Effect<void> =>
  TelemetryRow.$match(row, {
    ModelCall: call =>
      Effect.all(
        [
          Metric.update(
            Metric.withAttributes(modelCalls, { outcome: call.outcome }),
            1,
          ),
          Metric.update(
            Metric.withAttributes(modelLatency, { model: call.model }),
            millis(call.latency),
          ),
          Metric.update(
            Metric.withAttributes(modelTokens, { kind: 'input' }),
            call.tokens.input,
          ),
          Metric.update(
            Metric.withAttributes(modelTokens, { kind: 'output' }),
            call.tokens.output,
          ),
          Metric.update(
            Metric.withAttributes(modelTokens, { kind: 'cache_write' }),
            call.tokens.cache_write,
          ),
          Metric.update(
            Metric.withAttributes(modelTokens, { kind: 'cache_read' }),
            call.tokens.cache_read,
          ),
        ],
        { discard: true },
      ),
    ToolCall: call =>
      Metric.update(
        Metric.withAttributes(toolCalls, {
          decision: call.allowed ? 'allowed' : 'refused',
          asked: String(call.asked),
        }),
        millis(call.duration),
      ),
    Check: check =>
      Metric.update(
        Metric.withAttributes(checks, {
          suite: check.suite,
          result: check.result,
        }),
        millis(check.duration),
      ),
    Merge: merge =>
      Metric.update(
        Metric.withAttributes(merges, { outcome: merge.outcome }),
        millis(merge.duration),
      ),
    HandBack: handBack =>
      Metric.update(
        Metric.withAttributes(handBacks, { kind: handBack.kind }),
        1,
      ),
    Hold: hold =>
      Metric.update(
        Metric.withAttributes(holds, { hold: hold.hold }),
        millis(hold.duration),
      ),
    WorkerSession: session =>
      Metric.update(
        Metric.withAttributes(workerSessions, { outcome: session.outcome }),
        millis(session.duration),
      ),
    OrganCall: call =>
      Metric.update(
        Metric.withAttributes(organCalls, {
          organ: call.organ,
          outcome: call.outcome,
        }),
        millis(call.duration),
      ),
    HostSample: sample =>
      Metric.update(hostLoad, sample.load / Math.max(1, sample.cores)),
    ProcessSample: sample =>
      Metric.update(
        Metric.withAttributes(processRss, { process: sample.process }),
        sample.rssBytes,
      ),
  })
