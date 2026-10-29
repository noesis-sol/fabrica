import {
  Context,
  Data,
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
import type { OnBase, ReadyOptions, WaitReason } from './ready'

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

/** A ticket brought in whole from another tracker (§11.6): its ID, state and times as that tracker had them. */
export interface ImportedTicket {
  readonly ticket: Ticket
  readonly labels: ReadonlyArray<LabelName>
  readonly notes: ReadonlyArray<Note>
}

/** An imported edge the work graph left out: an end it has no ticket for, or a cycle it would close. */
export type DroppedEdge = Data.TaggedEnum<{
  Missing: { readonly edge: Edge; readonly id: TicketId }
  Cycle: { readonly edge: Edge }
}>
export const DroppedEdge = Data.taggedEnum<DroppedEdge>()

/** A ticket the graph had when an import brought it again, and the fields the import changed: none when it changed nothing. */
export interface MergedTicket {
  readonly id: TicketId
  readonly fields: ReadonlyArray<string>
}

/** What an import did with each ticket and edge. */
export interface ImportOutcome {
  readonly created: ReadonlyArray<TicketId>
  readonly merged: ReadonlyArray<MergedTicket>
  /** Tickets the graph deleted: left deleted, as their tombstones say (§11.7). */
  readonly deleted: ReadonlyArray<TicketId>
  readonly dropped: ReadonlyArray<DroppedEdge>
}

/** A ticket closed, and the tickets it blocks that aren't closed: closing offers to close them with it (§11.1). */
export interface ClosedTicket {
  readonly ticket: Ticket
  readonly offers: ReadonlyArray<Ticket>
}

type Found<A> = Effect.Effect<A, TicketNotFound | StoreFailed>
type Changed<A, E = never> = Effect.Effect<
  A,
  E | TicketNotFound | InvalidTicket | StoreFailed
>

export interface WorkGraphShape {
  /** The tickets ready to dispatch (§13.3), most urgent first, then oldest. */
  readonly ready: (
    options: ReadyOptions,
  ) => Effect.Effect<ReadonlyArray<Ticket>, StoreFailed>
  /** Each reason the ticket isn't ready, by the same rule as `ready`; none when it is. */
  readonly why: (
    options: ReadyOptions & { readonly id: TicketId },
  ) => Effect.Effect<ReadonlyArray<WaitReason>, TicketNotFound | StoreFailed>
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
  }) => Changed<ClosedTicket, TransitionRefused>
  /**
   * Closes each epic whose children are all closed and merged (§13.3), an epic among them first, so
   * that its parent closes in the same call: called once a ticket closes or merges. Returns the epics
   * closed.
   */
  readonly closeEpics: (options: {
    readonly onBase: OnBase
    readonly actor: Actor
  }) => Changed<ReadonlyArray<Ticket>>
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
  /**
   * Brings tickets from another tracker in with their IDs (§11.6), in one transaction, in batches
   * that yield. A ticket the graph hasn't is filed as it is. One it has merges until the tickets
   * ref's merge (§11.4) exists: its plain fields take the import's values, its status the later of
   * the two by §11.4's precedence, and its labels, notes (by ID) and edges are the union. Importing
   * the same tickets again changes nothing. An edge to a ticket neither has, or closing a `blocks`
   * or `parent` cycle, is dropped.
   */
  readonly importTickets: (options: {
    readonly tickets: ReadonlyArray<ImportedTicket>
    readonly edges: ReadonlyArray<Edge>
    readonly actor: Actor
  }) => Effect.Effect<ImportOutcome, InvalidTicket | StoreFailed>
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
