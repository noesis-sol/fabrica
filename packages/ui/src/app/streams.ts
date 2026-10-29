import { Array, Option, Schema, type Stream } from 'effect'
import type { RpcClientError } from 'effect/rpc'

import type { EngineClientShape, StreamItem } from '@fabrica/client'
import {
  AttentionPatch,
  AttentionRequest,
  BacklogPatch,
  HostLoad,
  type Resume,
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

/** A load sample replaces the one before. */
export const applyLoad = (
  current: Option.Option<HostLoad>,
  items: Array.NonEmptyReadonlyArray<typeof LoadItem.Type>,
): Option.Option<HostLoad> => applyItems(current, items, (_, sample) => sample)
