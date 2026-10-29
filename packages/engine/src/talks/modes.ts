import { Layer } from 'effect'

import { TalkModes } from './core'
import { featureMode } from './feature'
import { refineMode } from './refine'

// The talks' modes this engine has (spec §15.4), registered by name: each mode is a file of its own
// in this folder (refine, feature, answer, run), whose ticket adds it here.

/** The modes the engine serves. */
export const registeredModes: Layer.Layer<TalkModes> = Layer.succeed(TalkModes)(
  {
    refine: refineMode,
    feature: featureMode,
  },
)
