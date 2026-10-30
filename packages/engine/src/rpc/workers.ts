import { Effect, Layer } from 'effect'

import { WorkerRpcs } from '@fabrica/contracts'

import { Runs, layer as runsLayer } from '../run/registry'

// The Workers group's handlers (spec §8.1, §18.4) on the Runs service, the same the Runs group is
// served on: messaging (steering) a worker of a project's run, which holds the message while its ticket
// merges (H59), interrupting it, releasing it, and its transcript, streamed only to a client that asks
// for it (§8.3) and ending as the worker's part in the run ends. A worker is named by its project and
// its ticket.

/** The Workers group's handlers. */
export const workersHandlers = WorkerRpcs.toLayer(
  Effect.map(Runs, runs =>
    WorkerRpcs.of({
      'worker.message': ({ project, ticket, text }) =>
        runs.message({ project, ticket, text }),
      'worker.interrupt': ({ project, ticket }) =>
        runs.interrupt({ project, ticket }),
      'worker.release': ({ project, ticket }) =>
        runs.release({ project, ticket }),
      'worker.watchTranscript': ({ project, ticket, resume }) =>
        runs.watchTranscript({ project, ticket, resume }),
    }),
  ),
).pipe(Layer.provide(runsLayer))
