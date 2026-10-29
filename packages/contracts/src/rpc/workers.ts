import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { ProjectId, TicketId } from '../ids'
import { Text } from '../ticket'
import { ProjectNotFound } from './errors'
import { resume } from './stream'
import { TranscriptItem } from './transcript'

// The Workers group (spec §8.1, §18.4): messaging (steering) a worker, interrupting it, releasing it,
// and its transcript, streamed only while a client shows that worker (§8.3). A worker is named by its
// project and its ticket.

/** No worker at that ticket in the project's run. */
export class WorkerNotFound extends Schema.TaggedError<WorkerNotFound>()(
  'WorkerNotFound',
  { project: ProjectId, ticket: TicketId },
) {}

const worker = { project: ProjectId, ticket: TicketId }

const noWorker = Schema.Union([ProjectNotFound, WorkerNotFound])

export const WorkerRpcs = RpcGroup.make(
  /** Steers the worker: the engine sends it nothing more until it is released. */
  Rpc.make('worker.message', {
    payload: { ...worker, text: Text },
    error: noWorker,
  }),
  Rpc.make('worker.interrupt', { payload: worker, error: noWorker }),
  /** Hands the worker back to the engine after steering. */
  Rpc.make('worker.release', { payload: worker, error: noWorker }),
  Rpc.make('worker.watchTranscript', {
    payload: { ...worker, resume },
    success: TranscriptItem,
    error: noWorker,
    stream: true,
  }),
)
