import { Data, Duration } from 'effect'

import type {
  CheckResult,
  CheckSuite,
  HoldKind,
  ModelName,
  OrganKind,
  ProjectId,
  ProviderName,
  RunId,
  SetAsideReason,
  SettledOutcome,
  TicketId,
  Tokens,
} from '@fabrica/contracts'

// The rows telemetry records (spec §21, H65), one kind each, and the table and columns each kind is
// written to. Every row but a host sample is tied to its project, and to its run and ticket where it
// has them; a host sample is the machine's, across projects (§7.4). Times are written as epoch
// milliseconds, durations as whole milliseconds.

/** What a row is tied to: its project, and its run and ticket where it has them. */
export interface Tie {
  readonly project: ProjectId
  readonly run?: RunId | undefined
  readonly ticket?: TicketId | undefined
}

/** How a model call through the model proxy ended (§12.9). */
export type ModelCallOutcome = 'answered' | 'refused' | 'failed'

/** How a merge ended: merged, or set aside for its reason (§13.7). */
export type MergeOutcome = 'merged' | SetAsideReason

/** Which hand-back a ticket was given (§13.7). */
export type HandBackKind = 'resolve' | 'fix'

/** Whose process tree a process sample measured (§7.4). */
export type SampledProcess = 'worker' | 'check'

/** A row telemetry records. */
export type TelemetryRow = Data.TaggedEnum<{
  /** A model call through the model proxy (§12.9). */
  ModelCall: Tie & {
    readonly provider: ProviderName
    readonly model: ModelName
    readonly tokens: Tokens
    readonly costUsd?: number | undefined
    readonly latency: Duration.Duration
    readonly firstToken?: Duration.Duration | undefined
    readonly outcome: ModelCallOutcome
    /** The error's tag, for a refused or failed call. */
    readonly error?: string | undefined
  }
  /** A tool call, as the extension's gate decided it (§12.6). */
  ToolCall: Tie & {
    readonly tool: string
    readonly duration: Duration.Duration
    readonly allowed: boolean
    /** The gate asked the maintainer before deciding. */
    readonly asked: boolean
  }
  /** A check or a setup (§13.6, §13.7). */
  Check: Tie & {
    readonly suite: CheckSuite
    readonly duration: Duration.Duration
    readonly result: CheckResult
  }
  /** A ticket's merge turn (§13.7). */
  Merge: Tie & {
    readonly ticket: TicketId
    readonly duration: Duration.Duration
    readonly outcome: MergeOutcome
  }
  /** A hand-back to a ticket's worker (§13.7). */
  HandBack: Tie & {
    readonly ticket: TicketId
    readonly kind: HandBackKind
  }
  /** A hold, recorded when it lifts (§14). */
  Hold: Tie & {
    readonly hold: HoldKind
    readonly duration: Duration.Duration
  }
  /** A worker's session on a ticket, recorded when it settles (§12.3). */
  WorkerSession: Tie & {
    readonly ticket: TicketId
    readonly model: ModelName
    readonly duration: Duration.Duration
    readonly outcome: SettledOutcome
  }
  /** An organ call (§16). */
  OrganCall: Tie & {
    readonly organ: OrganKind
    readonly model?: ModelName | undefined
    readonly duration: Duration.Duration
    readonly outcome: 'answered' | 'no_result'
    readonly costUsd?: number | undefined
  }
  /** The host's load, across projects (§7.4). */
  HostSample: {
    /** The 1-minute load average. */
    readonly load: number
    readonly cores: number
    /** Memory pressure, 0 to 100, where the host reports it. */
    readonly memoryPressure?: number | undefined
    readonly swapUsedBytes?: number | undefined
  }
  /** A worker's or a check's process tree (§7.4). */
  ProcessSample: Tie & {
    readonly process: SampledProcess
    readonly rssBytes: number
  }
}>

export const TelemetryRow = Data.taggedEnum<TelemetryRow>()

export type RowKind = TelemetryRow['_tag']

/** The table each kind of row is written to. */
export const rowTables: { readonly [K in RowKind]: string } = {
  ModelCall: 'model_calls',
  ToolCall: 'tool_calls',
  Check: 'checks',
  Merge: 'merges',
  HandBack: 'hand_backs',
  Hold: 'holds',
  WorkerSession: 'worker_sessions',
  OrganCall: 'organ_calls',
  HostSample: 'host_samples',
  ProcessSample: 'process_samples',
}

/** A column's value as SQLite stores it. */
export type Column = string | number | null

/** A row's columns, its time included. */
export type Columns = Readonly<Record<string, Column>>

const millis = (duration: Duration.Duration): number =>
  Math.round(Duration.toMillis(duration))

const orNull = <A extends Column>(value: A | undefined): A | null =>
  value ?? null

const optionalMillis = (
  duration: Duration.Duration | undefined,
): number | null => (duration === undefined ? null : millis(duration))

const tieColumns = (tie: Tie) => ({
  project: tie.project,
  run: orNull(tie.run),
  ticket: orNull(tie.ticket),
})

/** The columns a row is written with, `at` its time in epoch milliseconds. */
export const columnsOf = (row: TelemetryRow, at: number): Columns =>
  TelemetryRow.$match(row, {
    ModelCall: call => ({
      at,
      ...tieColumns(call),
      provider: call.provider,
      model: call.model,
      input: call.tokens.input,
      output: call.tokens.output,
      cache_write: call.tokens.cache_write,
      cache_read: call.tokens.cache_read,
      cost_usd: orNull(call.costUsd),
      latency_ms: millis(call.latency),
      first_token_ms: optionalMillis(call.firstToken),
      outcome: call.outcome,
      error: orNull(call.error),
    }),
    ToolCall: call => ({
      at,
      ...tieColumns(call),
      tool: call.tool,
      duration_ms: millis(call.duration),
      allowed: call.allowed ? 1 : 0,
      asked: call.asked ? 1 : 0,
    }),
    Check: check => ({
      at,
      ...tieColumns(check),
      suite: check.suite,
      duration_ms: millis(check.duration),
      result: check.result,
    }),
    Merge: merge => ({
      at,
      ...tieColumns(merge),
      duration_ms: millis(merge.duration),
      outcome: merge.outcome,
    }),
    HandBack: handBack => ({
      at,
      ...tieColumns(handBack),
      kind: handBack.kind,
    }),
    Hold: hold => ({
      at,
      ...tieColumns(hold),
      hold: hold.hold,
      duration_ms: millis(hold.duration),
    }),
    WorkerSession: session => ({
      at,
      ...tieColumns(session),
      model: session.model,
      duration_ms: millis(session.duration),
      outcome: session.outcome,
    }),
    OrganCall: call => ({
      at,
      ...tieColumns(call),
      organ: call.organ,
      model: orNull(call.model),
      duration_ms: millis(call.duration),
      outcome: call.outcome,
      cost_usd: orNull(call.costUsd),
    }),
    HostSample: sample => ({
      at,
      load: sample.load,
      cores: sample.cores,
      memory_pressure: orNull(sample.memoryPressure),
      swap_used_bytes: orNull(sample.swapUsedBytes),
    }),
    ProcessSample: sample => ({
      at,
      ...tieColumns(sample),
      process: sample.process,
      rss_bytes: sample.rssBytes,
    }),
  })
