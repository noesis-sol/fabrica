import { Array, Option, Schema, type Stream } from 'effect'
import type { RpcClientError } from 'effect/rpc'

import type { EngineClientShape, StreamItem } from '@fabrica/client'
import {
  AttentionPatch,
  AttentionRequest,
  BacklogPatch,
  HostLoad,
  ProjectId,
  type Resume,
  type RunEvent,
  RunEvents,
  RunView,
  RunViewPatch,
  Ticket,
  applyAttentionPatch,
  applyKeyedPatch,
  applyRunViewPatch,
  streamItem,
} from '@fabrica/contracts'

// The streams the app keeps (spec §8.3, §18.1): each sends a snapshot, then patches, which the client
// has already put in order and resumed across lost connections. The Model keeps each stream's value,
// none until its first snapshot; a frame's items are applied in one go, and a part a patch leaves out
// keeps its identity, so a view drawing that part alone isn't redrawn.

export const RunViewItem = streamItem(RunView, RunViewPatch)
export const AttentionItem = streamItem(
  Schema.Array(AttentionRequest),
  AttentionPatch,
)
export const BacklogItem = streamItem(Schema.Array(Ticket), BacklogPatch)
export const LoadItem = streamItem(HostLoad, HostLoad)
export const EventsItem = streamItem(RunEvents, RunEvents)

/**
 * The client's resumed stream of `S` snapshots and `P` patches, subscribed through `subscribe`: the
 * two named here, since TypeScript can't read them off an RPC's tagged union.
 */
export const watchOf =
  <S, P>(client: EngineClientShape) =>
  <E, R>(
    subscribe: (
      resume: Option.Option<Resume>,
    ) => Stream.Stream<StreamItem<S, P>, E | RpcClientError.RpcClientError, R>,
  ) =>
    client.watch<S, P, E, R>(subscribe)

/** A frame's items of one stream, in the order they came. */
export const itemsOf = <S extends Schema.Top>(item: S) =>
  Schema.NonEmptyArray(item)

/** `current` with `items` applied: a snapshot takes the value's place, a patch changes the value it follows. */
export const applyItems = <S, P>(
  current: Option.Option<S>,
  items: Array.NonEmptyReadonlyArray<StreamItem<S, P>>,
  patch: (value: S, patch: P) => S,
): Option.Option<S> =>
  Array.reduce(items, current, (value, item) =>
    item._tag === 'snapshot'
      ? Option.some(item.value)
      : Option.map(value, before => patch(before, item.value)),
  )

export const applyRunView = (
  current: Option.Option<RunView>,
  items: Array.NonEmptyReadonlyArray<typeof RunViewItem.Type>,
): Option.Option<RunView> => applyItems(current, items, applyRunViewPatch)

export const applyAttention = (
  current: Option.Option<ReadonlyArray<AttentionRequest>>,
  items: Array.NonEmptyReadonlyArray<typeof AttentionItem.Type>,
): Option.Option<ReadonlyArray<AttentionRequest>> =>
  applyItems(current, items, applyAttentionPatch)

const byId = {
  of: (ticket: Ticket) => ticket.id,
  gone: (id: Ticket['id']) => id,
}

export const applyBacklog = (
  current: Option.Option<ReadonlyArray<Ticket>>,
  items: Array.NonEmptyReadonlyArray<typeof BacklogItem.Type>,
): Option.Option<ReadonlyArray<Ticket>> =>
  applyItems(current, items, (tickets, patch) =>
    applyKeyedPatch(tickets, patch, byId),
  )

/**
 * The run's events, kept newest first as History shows them (§18.3): a snapshot is the run's events
 * so far, a patch the events since, in the order they were written; each goes on at the top.
 */
export const applyEvents = (
  current: Option.Option<ReadonlyArray<RunEvent>>,
  items: Array.NonEmptyReadonlyArray<typeof EventsItem.Type>,
): Option.Option<ReadonlyArray<RunEvent>> =>
  Array.reduce(items, current, (events, item) =>
    item._tag === 'snapshot'
      ? Option.some(Array.reverse(item.value))
      : Option.map(events, before =>
          Array.appendAll(Array.reverse(item.value), before),
        ),
  )

/** One project's run's events, newest first, from its stream's first snapshot. */
export const ProjectEvents = Schema.Struct({
  project: ProjectId,
  events: RunEvents,
})
export type ProjectEvents = typeof ProjectEvents.Type

/**
 * `project`'s events with `items` applied (`applyEvents`): its entry takes their place, or joins the
 * list at its end; a patch before its first snapshot changes nothing, and the other entries keep their
 * identity.
 */
export const applyProjectEvents = (
  current: ReadonlyArray<ProjectEvents>,
  project: ProjectId,
  items: Array.NonEmptyReadonlyArray<typeof EventsItem.Type>,
): ReadonlyArray<ProjectEvents> => {
  const known = Array.findFirst(current, entry => entry.project === project)
  return Option.match(
    applyEvents(
      Option.map(known, entry => entry.events),
      items,
    ),
    {
      onNone: () => current,
      onSome: events =>
        Option.isSome(known)
          ? current.map(entry =>
              entry.project === project ? { project, events } : entry,
            )
          : [...current, { project, events }],
    },
  )
}

/** A load sample replaces the one before. */
export const applyLoad = (
  current: Option.Option<HostLoad>,
  items: Array.NonEmptyReadonlyArray<typeof LoadItem.Type>,
): Option.Option<HostLoad> => applyItems(current, items, (_, sample) => sample)
