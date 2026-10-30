import { Data, Effect } from 'effect'

import type { HoldKind } from '@fabrica/contracts'

import type { RunSnapshot } from './state'

// Whether the run may take work (spec §14, H58): one snapshot of plain values, read once per look. A
// no-op the loop calls until the holds as one state fill it (fab-mgi.4.11): the run may always take work.

export type MayTake = Data.TaggedEnum<{
  Yes: {}
  /** A hold: no new tickets until it lifts. */
  Held: { readonly hold: HoldKind; readonly why: string }
}>
export const MayTake = Data.taggedEnum<MayTake>()

/** Whether the run may dispatch, as its holds stand. */
export const mayTake = (_snapshot: RunSnapshot): Effect.Effect<MayTake> =>
  Effect.succeed(MayTake.Yes())
