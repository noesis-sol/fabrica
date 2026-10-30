import { Schema } from 'effect'

import { TranscriptItem } from '@fabrica/contracts'

import * as Worker from '../../../screens/worker'
import { itemsOf } from '../../streams'

// The Worker view's Messages (spec §18.4): its own, its keys, and the shown worker's transcript.

export const messages = {
  /** A Message of the Worker view's. */
  GotWorkerMessage: { message: Worker.Message },
  /** A Worker view's key (§18.5). */
  PressedWorkerKey: { key: Worker.Key },
  /** A frame of the shown worker's transcript (§18.4). */
  ReceivedWorkerTranscript: {
    worker: Worker.Shown,
    items: itemsOf(TranscriptItem),
  },
  /** The worker's transcript ended: the worker has finished. */
  EndedWorkerTranscript: { worker: Worker.Shown },
  /** The worker's transcript couldn't be read. */
  FailedWorkerTranscript: { worker: Worker.Shown, reason: Schema.String },
}
