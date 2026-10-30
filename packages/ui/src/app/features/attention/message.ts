import { Schema } from 'effect'

import * as Attention from '../../../console/attention'
import { AttentionItem, itemsOf } from '../../streams'

// The attention column's Messages (spec §15.1, §18.3): its own, the keys that answer its drawn options
// and its keyed permission request, and the scope's open requests on each engine.

export const messages = {
  GotAttentionMessage: { message: Attention.Message },
  /** A key 1–9 for the option at `place` (from 0) of the attention request `key`'s drawn options. */
  PressedAnswerKey: { key: Schema.String, place: Schema.Int },
  /** An approval key for the attention request `key`, the permission request the column keys. */
  PressedApprovalKey: { key: Schema.String, decision: Attention.ApprovalKey },
  /** The scope's open attention requests, on the engine named `engine`. */
  ReceivedAttention: { engine: Schema.String, items: itemsOf(AttentionItem) },
}
