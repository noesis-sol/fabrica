import { Effect, Layer } from 'effect'

import { RunRpcs } from '@fabrica/contracts'

import { Runs, layer as runsLayer } from '../run/registry'
import { notImplemented } from './not-implemented'

// The Runs group's handlers (spec §8.1, §13, §13.10, §13.12) on the Runs service, which this file
// provides on the daemon's projects, its scopes and what its runs run on: starting a run in a mode with
// its flags, stopping, draining and undraining it, its status, and its events stream. An overnight
// run's pre-flight (§15.6) and the run view's stream (§8.3) answer `NotImplemented` until the tickets
// that build them.

/** The Runs group's handlers. */
export const runsHandlers = RunRpcs.toLayer(
  Effect.map(Runs, runs =>
    RunRpcs.of({
      'run.start': ({ project, mode, flags }) =>
        Effect.map(runs.start({ project, mode, flags }), run => ({ run })),
      'run.stop': ({ project }) => runs.stop(project),
      'run.drain': ({ project }) => runs.drain(project),
      'run.undrain': ({ project }) => runs.undrain(project),
      'run.status': ({ project }) => runs.status(project),
      'run.preflight': notImplemented('run.preflight'),
      'run.watchView': notImplemented('run.watchView'),
      'run.watchEvents': ({ project, run, resume }) =>
        runs.watchEvents({ project, run, resume }),
    }),
  ),
).pipe(Layer.provide(runsLayer))
