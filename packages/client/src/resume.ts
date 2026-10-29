import { Data, Effect, Match, Option, Ref, Result, Stream } from 'effect'
import { RpcClientError } from 'effect/rpc'

import { Resume, type Sequence, type StreamEpoch } from '@fabrica/contracts'

// Resuming a stream (spec §8.3): a stream sends a full snapshot, then patches, each with a sequence
// number. The client keeps where it stands, the snapshot's epoch and the last sequence number it took,
// and after a dropped connection subscribes again asking for the patches after it; the engine sends
// them, or a new snapshot when the client is too far behind or the engine's copy of the stream is
// another. A patch that doesn't follow the last item the client took (a gap, or a patch before any
// snapshot) can't be applied: the client subscribes afresh and takes a new snapshot.

/** A stream's item, as `streamItem` in the contracts makes it. */
export type StreamItem<S, P> =
  | {
      readonly _tag: 'snapshot'
      readonly epoch: StreamEpoch
      readonly seq: Sequence
      readonly value: S
    }
  | { readonly _tag: 'patch'; readonly seq: Sequence; readonly value: P }

/** A patch that doesn't follow the last item taken: `at` is where the client stood. */
export class SequenceGap extends Data.TaggedError('SequenceGap')<{
  readonly at: Option.Option<Resume>
  readonly seq: Sequence
}> {}

/** Where a stream stands after `item`: a snapshot sets it, a patch must follow it by one. */
export const advance = <S, P>(
  at: Option.Option<Resume>,
  item: StreamItem<S, P>,
): Result.Result<Resume, SequenceGap> =>
  Match.valueTags(item, {
    snapshot: ({ epoch, seq }) =>
      Result.succeed(new Resume({ epoch, after: seq })),
    patch: ({ seq }) =>
      Option.match(
        Option.filter(at, ({ after }) => seq === after + 1),
        {
          onNone: () => Result.fail(new SequenceGap({ at, seq })),
          onSome: ({ epoch }) =>
            Result.succeed(new Resume({ epoch, after: seq })),
        },
      ),
  })

/**
 * The items of a stream subscribed through `subscribe`, kept going across lost connections: when the
 * stream fails with the connection's loss, it waits for `reconnected` (the wait for the connection
 * after the one the subscription was made on, read as it is made) and subscribes again from where it
 * stood.
 */
export const resumable = <S, P, E, R, F>(options: {
  readonly subscribe: (
    resume: Option.Option<Resume>,
  ) => Stream.Stream<StreamItem<S, P>, E | RpcClientError.RpcClientError, R>
  readonly reconnected: Effect.Effect<Effect.Effect<void, F>>
}): Stream.Stream<
  StreamItem<S, P>,
  Exclude<E, RpcClientError.RpcClientError> | F,
  R
> => {
  /** Whether an error is the stream's own rather than the connection's loss. */
  const isOwn = (
    error: E | RpcClientError.RpcClientError,
  ): error is Exclude<E, RpcClientError.RpcClientError> =>
    !(error instanceof RpcClientError.RpcClientError)
  const subscribe = (
    cursor: Ref.Ref<Option.Option<Resume>>,
  ): Stream.Stream<
    StreamItem<S, P>,
    Exclude<E, RpcClientError.RpcClientError> | F,
    R
  > =>
    Stream.unwrap(
      Effect.gen(function* () {
        const reconnected = yield* options.reconnected
        const from = yield* Ref.get(cursor)
        return options.subscribe(from).pipe(
          Stream.mapEffect(item =>
            Effect.flatMap(Ref.get(cursor), at =>
              Result.match(advance(at, item), {
                onFailure: gap => Effect.fail(gap),
                onSuccess: next =>
                  Effect.as(Ref.set(cursor, Option.some(next)), item),
              }),
            ),
          ),
          Stream.catch(
            (error: E | RpcClientError.RpcClientError | SequenceGap) => {
              if (error instanceof SequenceGap) {
                return Stream.unwrap(
                  Effect.as(Ref.set(cursor, Option.none()), subscribe(cursor)),
                )
              }
              if (isOwn(error)) {
                return Stream.fail(error)
              }
              return Stream.unwrap(Effect.as(reconnected, subscribe(cursor)))
            },
          ),
        )
      }),
    )
  return Stream.unwrap(Effect.map(Ref.make(Option.none<Resume>()), subscribe))
}
