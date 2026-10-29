import { Schema } from 'effect'

import { HoldKind, ModelName, ProviderName, Tokens } from '../events'
import { EngineId, ProjectId, RunId, SessionId, TicketId } from '../ids'
import { CountsAs, Phase } from '../phases'
import { Priority, Text, TicketType } from '../ticket'
import {
  AttentionPatch,
  AttentionRequest,
  applyAttentionPatch,
} from './attention'
import { Count, Moment, Ordinal, Usd } from './common'
import { HostLoad } from './engine'
import { applyKeyedPatch, keyedPatch } from './stream'

// The run view (spec §8.3): the immutable projection of what the console shows of a run (§18.3), its
// totals, ticket rows, workers, merge queue, holds, banners, open attention requests, the host's load
// and the engine's steps under way, each with its start time (H80). The engine sends it whole, then
// patches naming only the parts that changed; a part a patch leaves out keeps its identity, so a
// component drawing one part redraws only when it changes (§18.5).

/** What a run works on (§13.1). */
export const RunMode = Schema.TaggedUnion({
  /** The current tickets. */
  tickets: {},
  /** One ticket and its descendants. */
  ticket: { ticket: TicketId },
  /** A spec: a file in the project or an https URL (§15.5). */
  spec: { source: Text, refine: Schema.Boolean },
  feature: { text: Text },
  overnight: {},
}).annotate({ identifier: 'RunMode' })
export type RunMode = typeof RunMode.Type

/** Where a run is: getting ready (its start's steps, H80), running, draining, or winding down to stop. */
export const RunState = Schema.Literals([
  'starting',
  'running',
  'draining',
  'stopping',
])
export type RunState = typeof RunState.Type

/** The run itself. */
export class RunHeader extends Schema.Class<RunHeader>('RunHeader')({
  run: RunId,
  project: ProjectId,
  engine: EngineId,
  mode: RunMode,
  state: RunState,
  startedAt: Moment,
  /** Started with `--offline`: its lease unchecked (§11.5). */
  offline: Schema.Boolean,
  autoAnswer: Schema.Boolean,
}) {}

/** How many tickets count as each of `CountsAs` (the stats row, §18.3). */
export const Counts = Schema.Struct({
  in_queue: Count,
  working: Count,
  waiting_to_merge: Count,
  needs_you: Count,
  set_aside: Count,
  carried_over: Count,
  done: Count,
} satisfies { readonly [K in CountsAs]: unknown })
export type Counts = typeof Counts.Type

/** The stats row's figures. */
export class Totals extends Schema.Class<Totals>('Totals')({
  /** Workers live, against the run's slots. */
  live: Count,
  slots: Count,
  counts: Counts,
  /**
   * The project's tickets merged or closed with no change since the engine host's local midnight,
   * whichever run did them (`counts.done` is this run's alone): the stats row's Done today.
   */
  doneToday: Count,
  tokens: Tokens,
  costUsd: Schema.OptionFromNullOr(Usd),
}) {}

/** A ticket's row: its phase, since when, and its hand-backs. */
export class TicketRow extends Schema.Class<TicketRow>('TicketRow')({
  ticket: TicketId,
  title: Text,
  type: TicketType,
  priority: Priority,
  phase: Phase,
  /** In this phase since. */
  since: Moment,
  /** When the run first took it up. */
  startedAt: Schema.OptionFromNullOr(Moment),
  solo: Schema.Boolean,
  handBacks: Schema.Struct({ resolve: Count, fix: Count }),
}) {}

/** A worker's latest action, from its Pi events: the tool and its main argument (§18.3). */
export class WorkerAction extends Schema.Class<WorkerAction>('WorkerAction')({
  tool: Text,
  argument: Schema.OptionFromNullOr(Text),
  at: Moment,
}) {}

/** A worker at a ticket. */
export class WorkerRow extends Schema.Class<WorkerRow>('WorkerRow')({
  ticket: TicketId,
  session: SessionId,
  model: ModelName,
  startedAt: Moment,
  action: Schema.OptionFromNullOr(WorkerAction),
  /** Tokens in its context, against its model's window. */
  context: Schema.OptionFromNullOr(
    Schema.Struct({ used: Count, window: Ordinal }),
  ),
  /** Messaged by the maintainer: the engine sends it nothing until released (§18.4). */
  steered: Schema.Boolean,
}) {}

/** The merge queue (§13.7): the ticket merging, the one in the train, and those waiting, next first. */
export class MergeQueue extends Schema.Class<MergeQueue>('MergeQueue')({
  merging: Schema.OptionFromNullOr(TicketId),
  train: Schema.OptionFromNullOr(TicketId),
  waiting: Schema.Array(TicketId),
}) {}

/** A hold on the run (§14): why, since when, and when it lifts where that is known. */
export class Hold extends Schema.Class<Hold>('Hold')({
  kind: HoldKind,
  reason: Text,
  since: Moment,
  lifts: Schema.OptionFromNullOr(Moment),
  /** The provider a usage-limit or credentials hold is for. */
  provider: Schema.OptionFromNullOr(ProviderName),
}) {}

/** A banner over the stats row: a hold (`c2`), a stop (`c3`), or a warning (the battery, a narrow tree). */
export class Banner extends Schema.Class<Banner>('Banner')({
  tone: Schema.Literals(['hold', 'stop', 'warning']),
  text: Text,
  lifts: Schema.OptionFromNullOr(Moment),
}) {}

/** An engine step that may take more than a second (§8.3, H80). */
export const StepKind = Schema.Literals([
  'start_checks',
  'backlog',
  'carry_over',
  'setup',
  'merge_check',
  'full_check_setup',
  'full_check',
  'report',
  'install',
  'breakdown',
])
export type StepKind = typeof StepKind.Type

/** A step under way, with its start time, and the ticket it is for where it has one. */
export class EngineStep extends Schema.Class<EngineStep>('EngineStep')({
  step: StepKind,
  ticket: Schema.OptionFromNullOr(TicketId),
  startedAt: Moment,
}) {}

/** A run's view. */
export const RunView = Schema.Struct({
  header: RunHeader,
  totals: Totals,
  tickets: Schema.Array(TicketRow),
  workers: Schema.Array(WorkerRow),
  queue: MergeQueue,
  holds: Schema.Array(Hold),
  banners: Schema.Array(Banner),
  attention: Schema.Array(AttentionRequest),
  /** None until the first sample. */
  load: Schema.OptionFromNullOr(HostLoad),
  steps: Schema.Array(EngineStep),
})
export type RunView = typeof RunView.Type

/** The parts of a run's view that changed: a small part whole, a list of rows by its changed and gone rows. */
export const RunViewPatch = Schema.Struct({
  header: Schema.optionalKey(RunHeader),
  totals: Schema.optionalKey(Totals),
  tickets: Schema.optionalKey(keyedPatch(TicketRow, TicketId)),
  workers: Schema.optionalKey(keyedPatch(WorkerRow, TicketId)),
  queue: Schema.optionalKey(MergeQueue),
  holds: Schema.optionalKey(Schema.Array(Hold)),
  banners: Schema.optionalKey(Schema.Array(Banner)),
  attention: Schema.optionalKey(AttentionPatch),
  load: Schema.optionalKey(Schema.OptionFromNullOr(HostLoad)),
  steps: Schema.optionalKey(Schema.Array(EngineStep)),
})
export type RunViewPatch = typeof RunViewPatch.Type

const byTicket = {
  of: ({ ticket }: { readonly ticket: TicketId }) => ticket,
  gone: (ticket: TicketId) => ticket,
}

/** `view` with `patch` applied; every part the patch leaves out is the same value as before. */
export const applyRunViewPatch = (
  view: RunView,
  patch: RunViewPatch,
): RunView => ({
  header: patch.header ?? view.header,
  totals: patch.totals ?? view.totals,
  tickets:
    patch.tickets === undefined
      ? view.tickets
      : applyKeyedPatch(view.tickets, patch.tickets, byTicket),
  workers:
    patch.workers === undefined
      ? view.workers
      : applyKeyedPatch(view.workers, patch.workers, byTicket),
  queue: patch.queue ?? view.queue,
  holds: patch.holds ?? view.holds,
  banners: patch.banners ?? view.banners,
  attention:
    patch.attention === undefined
      ? view.attention
      : applyAttentionPatch(view.attention, patch.attention),
  load: patch.load ?? view.load,
  steps: patch.steps ?? view.steps,
})
