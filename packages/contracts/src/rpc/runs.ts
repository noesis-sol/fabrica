import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { EndKind, RunEvent, StopKind } from '../events'
import { ProjectId, RunId, TicketId } from '../ids'
import { Text } from '../ticket'
import { Count, Moment, Ordinal, optional } from './common'
import { ProjectNotFound } from './errors'
import { RunHeader, RunMode, RunView, RunViewPatch } from './run-view'
import { resume, streamItem } from './stream'

// The Runs group (spec §8.1, §13): starting a run in a mode with its flags, stopping, draining and
// undraining it, its status, an overnight run's pre-flight (§15.6), and the streams of its view (§8.3)
// and its events (§13.12).

/**
 * What a pre-flight line is about (§15.6), one line for each: a start names the lines it fixes or
 * overrides by it. The first six refuse the start, the rest warn.
 */
export const PreflightCheck = Schema.Literals([
  /** A dispatch limit set. */
  'limit_set',
  /** `concurrent` under 2. */
  'concurrent_low',
  /** Base failing `check_fast`. */
  'base_failing',
  /** `permissions: ask`: workers would wait on the maintainer. */
  'permissions_ask',
  /** A model's credentials missing or rejected. */
  'credentials',
  /** Free disk on the engine's host under `overnight.min_free_disk`. */
  'free_disk',
  /** `usage_limit_wait` under 5h. */
  'usage_limit_wait',
  /** No `ticket_limit`. */
  'no_ticket_limit',
  /** Another heavy run on the engine, or heavy load on its host. */
  'heavy_load',
  /** Older worker rules. */
  'worker_rules',
  /** The host on battery. */
  'battery',
])
export type PreflightCheck = typeof PreflightCheck.Type

/**
 * What an overnight start makes of its pre-flight (§15.6): the offered fixes, made together as the run
 * starts, so a checklist cancelled before changes nothing; and the refusals overridden.
 */
export class PreflightChoices extends Schema.Class<PreflightChoices>(
  'PreflightChoices',
)({
  fix: Schema.Array(PreflightCheck),
  override: Schema.Array(PreflightCheck),
}) {}

/**
 * A run's flags (§19). `settings` are the settings flags, by setting path, as their text
 * (`{ concurrent: "3", auto_answer: "10m" }` for `--concurrent 3 --auto-answer=10m`): the engine
 * resolves them with the project's and its own settings, so a problem names the flag it came from.
 */
export const RunFlags = Schema.Struct({
  /** Caps the run's dispatches; none: no limit. */
  limit: optional(Ordinal),
  /** Start without the remote: the lease unchecked (§11.5). */
  offline: Schema.Boolean,
  settings: Schema.Record(Schema.String, Schema.String),
  /** An overnight run's pre-flight gone through (§15.6); none: its refusals refuse the start. */
  preflight: optional(PreflightChoices),
})
export type RunFlags = typeof RunFlags.Type

/** How a run ended. */
export class RunEnded extends Schema.Class<RunEnded>('RunEnded')({
  run: RunId,
  end: EndKind,
  endedAt: Moment,
}) {}

/** A project's run: none going, with how the last one ended, or the run going. */
export const RunStatus = Schema.TaggedUnion({
  idle: { last: Schema.OptionFromNullOr(RunEnded) },
  going: { header: RunHeader },
})
export type RunStatus = typeof RunStatus.Type

/** One line of a pre-flight: what is wrong, and the fix it offers. */
export class PreflightItem extends Schema.Class<PreflightItem>('PreflightItem')(
  {
    check: PreflightCheck,
    text: Text,
    fix: Schema.OptionFromNullOr(Text),
  },
) {}

/** An overnight run's pre-flight checklist (§15.6). */
export class Preflight extends Schema.Class<Preflight>('Preflight')({
  /** What keeps the run from starting until fixed or overridden. */
  refusals: Schema.Array(PreflightItem),
  warnings: Schema.Array(PreflightItem),
  /** The open questions to answer first. */
  questions: Schema.Array(TicketId),
  ready: Count,
  waitingOnQuestions: Count,
}) {}

/** The run didn't start: its start checks' problems, all together (§13.1), and how it ended. */
export class RunRefused extends Schema.TaggedError<RunRefused>()('RunRefused', {
  end: StopKind,
  problems: Schema.NonEmptyArray(Text),
}) {}

/** The project has a run going already: one run per project (§7.3). */
export class RunGoing extends Schema.TaggedError<RunGoing>()('RunGoing', {
  project: ProjectId,
  run: RunId,
}) {}

/** The project has no run going. */
export class NoRun extends Schema.TaggedError<NoRun>()('NoRun', {
  project: ProjectId,
}) {}

/** No run with that ID in the project. */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  'RunNotFound',
  { project: ProjectId, run: RunId },
) {}

const ofTheRun = Schema.Union([ProjectNotFound, NoRun])

/** Run events, as a stream's snapshot and patches carry them. */
export const RunEvents = Schema.Array(RunEvent).annotate({
  identifier: 'RunEvents',
})

/** The run events stream's items: the records so far, then each record as it is written. */
export const RunEventsItem = streamItem(RunEvents, RunEvents)
export type RunEventsItem = typeof RunEventsItem.Type

export const RunRpcs = RpcGroup.make(
  Rpc.make('run.start', {
    payload: { project: ProjectId, mode: RunMode, flags: RunFlags },
    success: Schema.Struct({ run: RunId }),
    error: Schema.Union([ProjectNotFound, RunGoing, RunRefused]),
  }),
  Rpc.make('run.stop', { payload: { project: ProjectId }, error: ofTheRun }),
  Rpc.make('run.drain', { payload: { project: ProjectId }, error: ofTheRun }),
  Rpc.make('run.undrain', {
    payload: { project: ProjectId },
    error: ofTheRun,
  }),
  Rpc.make('run.status', {
    payload: { project: ProjectId },
    success: RunStatus,
    error: ProjectNotFound,
  }),
  Rpc.make('run.preflight', {
    payload: { project: ProjectId, mode: RunMode, flags: RunFlags },
    success: Preflight,
    error: ProjectNotFound,
  }),
  Rpc.make('run.watchView', {
    payload: { project: ProjectId, resume },
    success: streamItem(RunView, RunViewPatch),
    error: ofTheRun,
    stream: true,
  }),
  /** The run's events: the run going, or an earlier one by its ID. */
  Rpc.make('run.watchEvents', {
    payload: { project: ProjectId, run: optional(RunId), resume },
    success: RunEventsItem,
    error: Schema.Union([ProjectNotFound, NoRun, RunNotFound]),
    stream: true,
  }),
)
