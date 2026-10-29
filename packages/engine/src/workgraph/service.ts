import {
  Context,
  type DateTime,
  type Effect,
  type Option,
  type Scope,
  type Stream,
} from 'effect'

import type {
  Actor,
  Assignee,
  CommitHash,
  Edge,
  LabelName,
  ModelOverride,
  Note,
  Priority,
  QuestionChoices,
  Resolution,
  Ticket,
  TicketEvent,
  TicketId,
  TicketMetadata,
  TicketResult,
  TicketStatus,
  TicketType,
} from '@fabrica/contracts'

import type {
  EdgeCycle,
  InvalidTicket,
  NotAQuestion,
  StoreFailed,
  TicketNotFound,
  TransitionRefused,
} from './errors'
import type { ReadyNotBuilt, WaitReason } from './ready'

// The tracker interface (spec §11.1): every ticket operation goes through `WorkGraph`, the only code
// that knows the backend. Each mutation names its actor, and appends an event with it (§11.2).

/** A ticket to file. Questions are filed with `ask`. */
export interface NewTicket {
  readonly type: Exclude<TicketType, 'question'>
  readonly title: string
  readonly description?: string
  readonly design?: string
  readonly acceptance?: string
  /** 2 when left out. */
  readonly priority?: Priority
  readonly model?: ModelOverride
  readonly metadata?: TicketMetadata
  readonly labels?: ReadonlyArray<LabelName>
  /** Its parent: the ticket is filed as the parent's next child, `<parent>.<n>`, with a `parent` edge. */
  readonly parent?: TicketId
}

/** The plain fields an update changes; a field left out stays, `Option.none()` empties it. */
export interface TicketUpdate {
  readonly title?: string
  readonly description?: Option.Option<string>
  readonly design?: Option.Option<string>
  readonly acceptance?: Option.Option<string>
  readonly priority?: Priority
  readonly model?: Option.Option<ModelOverride>
  readonly metadata?: TicketMetadata
  readonly result?: Option.Option<TicketResult>
  readonly mergedCommit?: Option.Option<CommitHash>
}

/** A question for the maintainer (§15). */
export interface NewQuestion {
  readonly title: string
  readonly description?: string
  readonly priority?: Priority
  /** Its options; none when a talk is to draft them. */
  readonly choices?: QuestionChoices
  readonly consequential: boolean
  readonly maintainerOnly: boolean
  /** The tickets waiting on the answer: the question blocks each. */
  readonly blocks?: ReadonlyArray<TicketId>
}

/** How a discovered ticket links to the one it was found from (the worker's `file_ticket` links). */
export type DiscoveredLink = 'blocks' | 'discovered_from' | 'related'

/** Which tickets `list` gives; every ticket when empty. */
export interface TicketFilter {
  readonly statuses?: ReadonlyArray<TicketStatus>
  readonly types?: ReadonlyArray<TicketType>
  readonly label?: LabelName
}

/** A ticket with its labels, its edges either way, and its notes, oldest first. */
export interface TicketDetail {
  readonly ticket: Ticket
  readonly labels: ReadonlyArray<LabelName>
  readonly edges: ReadonlyArray<Edge>
  readonly notes: ReadonlyArray<Note>
}

type Found<A> = Effect.Effect<A, TicketNotFound | StoreFailed>
type Changed<A, E = never> = Effect.Effect<
  A,
  E | TicketNotFound | InvalidTicket | StoreFailed
>

export interface WorkGraphShape {
  /** The tickets ready to dispatch (§13.3). */
  readonly ready: () => Effect.Effect<
    ReadonlyArray<Ticket>,
    ReadyNotBuilt | StoreFailed
  >
  /** Each reason the ticket isn't ready. */
  readonly why: (
    id: TicketId,
  ) => Effect.Effect<
    ReadonlyArray<WaitReason>,
    ReadyNotBuilt | TicketNotFound | StoreFailed
  >
  readonly show: (id: TicketId) => Found<TicketDetail>
  /** The tickets the filter takes, most urgent first, then oldest; read in batches that yield. */
  readonly list: (
    filter?: TicketFilter,
  ) => Effect.Effect<ReadonlyArray<Ticket>, StoreFailed>
  readonly create: (options: {
    readonly ticket: NewTicket
    readonly actor: Actor
  }) => Changed<Ticket, EdgeCycle>
  readonly update: (options: {
    readonly id: TicketId
    readonly changes: TicketUpdate
    readonly actor: Actor
  }) => Changed<Ticket>
  /** Takes an open ticket for a worker: in progress, assigned, with a lease (§11.5). */
  readonly claim: (options: {
    readonly id: TicketId
    readonly assignee: Assignee
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  /** Gives an in-progress ticket back: open, unassigned. */
  readonly release: (options: {
    readonly id: TicketId
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  readonly close: (options: {
    readonly id: TicketId
    readonly resolution: Resolution
    readonly reason?: string
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  readonly reopen: (options: {
    readonly id: TicketId
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  /** Sets a ticket aside, until a time or until undeferred; its assignee stays, so its session can resume. */
  readonly defer: (options: {
    readonly id: TicketId
    readonly until: Option.Option<DateTime.Utc>
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  readonly undefer: (options: {
    readonly id: TicketId
    readonly actor: Actor
  }) => Changed<Ticket, TransitionRefused>
  /** Adds the edge; one already there changes nothing. A `blocks` or `parent` edge closing a cycle is refused. */
  readonly addDependency: (options: {
    readonly edge: Edge
    readonly actor: Actor
  }) => Changed<void, EdgeCycle>
  /** Removes the edge; one not there changes nothing. */
  readonly removeDependency: (options: {
    readonly edge: Edge
    readonly actor: Actor
  }) => Changed<void>
  readonly label: (options: {
    readonly id: TicketId
    readonly label: LabelName
    readonly actor: Actor
  }) => Changed<void>
  readonly unlabel: (options: {
    readonly id: TicketId
    readonly label: LabelName
    readonly actor: Actor
  }) => Changed<void>
  readonly note: (options: {
    readonly id: TicketId
    readonly body: string
    readonly actor: Actor
  }) => Changed<Note>
  /** Files a ticket found while working on `from`, linked to it. */
  readonly fileDiscovered: (options: {
    readonly from: TicketId
    readonly link: DiscoveredLink
    readonly ticket: NewTicket
    readonly actor: Actor
  }) => Changed<Ticket, EdgeCycle>
  /** Files a question, blocking the tickets waiting on it. */
  readonly ask: (options: {
    readonly question: NewQuestion
    readonly actor: Actor
  }) => Changed<Ticket, EdgeCycle>
  /** Answers a question, closing it as answered. */
  readonly answer: (options: {
    readonly id: TicketId
    readonly answer: string
    readonly actor: Actor
  }) => Changed<Ticket, NotAQuestion | TransitionRefused>
  /** Deletes a ticket, its labels, edges and notes, leaving a tombstone (§11.7); its history stays. */
  readonly delete: (options: {
    readonly id: TicketId
    readonly actor: Actor
  }) => Changed<void>
  /** Every event of the ticket, oldest first; a deleted ticket's too. */
  readonly history: (
    id: TicketId,
  ) => Effect.Effect<ReadonlyArray<TicketEvent>, StoreFailed>
  /**
   * Subscribes to the events appended from now on: once it returns, every event appended is on the
   * stream, in order, until the scope closes.
   */
  readonly changes: Effect.Effect<
    Stream.Stream<TicketEvent, StoreFailed>,
    StoreFailed,
    Scope.Scope
  >
}

export class WorkGraph extends Context.Service<WorkGraph, WorkGraphShape>()(
  '@fabrica/engine/WorkGraph',
) {}
