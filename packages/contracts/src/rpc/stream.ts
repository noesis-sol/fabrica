import { Data, Option, Schema } from 'effect'

// Streams (spec §8.3): a stream sends a full snapshot, then patches, each with a sequence number. A
// client that reconnects asks for the patches after its last sequence number; one too far behind
// gets a new snapshot. A stream's epoch names the engine's copy of it, so a client resuming after
// the engine restarted, whose numbers mean nothing to the new engine, gets a new snapshot too.

/** A stream item's number: the snapshot's, then one more for each patch. */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type Sequence = typeof Sequence.Type

/** One run of a stream's numbering, chosen by the engine; a snapshot gives it. */
export const StreamEpoch = Schema.String.check(Schema.isPattern(/^\S+$/u)).pipe(
  Schema.brand('StreamEpoch'),
)
export type StreamEpoch = typeof StreamEpoch.Type

/** Where a reconnecting client left a stream: its epoch and the last sequence number it applied. */
export class Resume extends Schema.Class<Resume>('Resume')({
  epoch: StreamEpoch,
  after: Sequence,
}) {}

/** A stream request's resume point: none for a new subscription. */
export const resume = Schema.OptionFromOptionalKey(Resume)

/** A stream's items: a full snapshot of `snapshot`, then patches of `patch`. */
export const streamItem = <S extends Schema.Top, P extends Schema.Top>(
  snapshot: S,
  patch: P,
) =>
  Schema.TaggedUnion({
    snapshot: { epoch: StreamEpoch, seq: Sequence, value: snapshot },
    patch: { seq: Sequence, value: patch },
  })

/** What the engine sends a stream's subscriber first. */
export type ResumePlan = Data.TaggedEnum<{
  /** A full snapshot: a new subscriber, another epoch, or one too far behind or ahead. */
  Snapshot: {}
  /** The patches after `after`, which the engine still has. */
  PatchesAfter: { readonly after: Sequence }
}>
export const ResumePlan = Data.taggedEnum<ResumePlan>()

/**
 * How the engine answers a subscription (the one rule, §8.3): `epoch` is its stream's, `oldest` the
 * first patch it still keeps (or the next it will send, when it keeps none), `latest` the last
 * sequence number it sent.
 */
export const planResume = (options: {
  readonly resume: Option.Option<Resume>
  readonly epoch: StreamEpoch
  readonly oldest: Sequence
  readonly latest: Sequence
}): ResumePlan => {
  const { epoch, oldest, latest } = options
  return Option.match(
    Option.filter(
      options.resume,
      ({ epoch: theirs, after }) =>
        theirs === epoch && after >= oldest - 1 && after <= latest,
    ),
    {
      onNone: () => ResumePlan.Snapshot(),
      onSome: ({ after }) => ResumePlan.PatchesAfter({ after }),
    },
  )
}

/**
 * A patch to a list of things with keys: the items added or changed, whole, and those gone. `gone`
 * holds `Gone`, a key or a record of the item's going that names its key.
 */
export const keyedPatch = <A extends Schema.Top, Gone extends Schema.Top>(
  item: A,
  gone: Gone,
) =>
  Schema.Struct({
    upsert: Schema.Array(item),
    remove: Schema.Array(gone),
  })

/**
 * `items` with `patch` applied: a changed item replaces the one with its key, in its place; a new one
 * goes at the end; a gone one leaves. Items the patch doesn't name keep their identity, and an empty
 * patch returns `items` itself.
 */
export const applyKeyedPatch = <A, Gone>(
  items: ReadonlyArray<A>,
  patch: {
    readonly upsert: ReadonlyArray<A>
    readonly remove: ReadonlyArray<Gone>
  },
  keys: {
    readonly of: (item: A) => string
    readonly gone: (gone: Gone) => string
  },
): ReadonlyArray<A> => {
  if (patch.upsert.length === 0 && patch.remove.length === 0) {
    return items
  }
  const gone = new Set(patch.remove.map(keys.gone))
  const changed = new Map(patch.upsert.map(item => [keys.of(item), item]))
  const kept = items.flatMap(item => {
    const key = keys.of(item)
    if (gone.has(key)) {
      return []
    }
    const next = changed.get(key)
    changed.delete(key)
    return [next ?? item]
  })
  return [
    ...kept,
    ...[...changed.values()].filter(item => !gone.has(keys.of(item))),
  ]
}
