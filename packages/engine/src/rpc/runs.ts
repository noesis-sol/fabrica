import { Effect } from 'effect'

import { RunRpcs } from '@fabrica/contracts'

import { Runs } from '../run/registry'
import { notImplemented } from './not-implemented'

// The Runs group's handlers (spec §8.1, §13, §13.10, §13.12) on the daemon's Runs service: starting a
// run in a mode with its flags, stopping, draining and undraining it, its status, its view's stream
// (§8.3), its events stream and the run talk's actions with no run going (§15.4). An overnight run's pre-flight (§15.6) answers `NotImplemented` until the ticket that builds it.

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
      'run.watchView': ({ project, resume }) =>
        runs.watchView({ project, resume }),
      'run.watchEvents': ({ project, run, resume }) =>
        runs.watchEvents({ project, run, resume }),
      'run.watchTalkActions': ({ project, resume }) =>
        runs.watchTalkActions({ project, resume }),
    }),
  ),
)
