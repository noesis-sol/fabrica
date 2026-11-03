import { Effect, Layer } from 'effect'

import { AttentionRequests } from '../attention/service'
import { Projects } from '../projects/service'
import { Runs } from '../run/registry'
import { TalkModes } from './core'
import { featureMode } from './feature'
import { refineMode } from './refine'
import { runMode } from './run'

// The talks' modes this engine has (spec §15.4), registered by name: each mode is a file of its own
// in this folder (refine, feature, answer, run), whose ticket adds it here.

/** The modes the engine serves. */
export const registeredModes: Layer.Layer<TalkModes> = Layer.succeed(TalkModes)(
  {
    refine: refineMode,
    feature: featureMode,
  },
)

/**
 * The run talk beside the modes given, on the engine's runs, attention requests and projects, which
 * the modes above need none of: a run mode given stays, for a test's own.
 */
export const withRunTalk: Layer.Layer<
  TalkModes,
  never,
  TalkModes | Runs | AttentionRequests | Projects
> = Layer.effect(
  TalkModes,
  Effect.gen(function* () {
    const given = yield* TalkModes
    const [runs, attention, projects] = yield* Effect.all([
      Runs,
      AttentionRequests,
      Projects,
    ])
    return { run: runMode({ runs, attention, projects }), ...given }
  }),
)
