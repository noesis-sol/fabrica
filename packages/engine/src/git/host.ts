import { Layer } from 'effect'

import { layerAwake, layerHost } from '../process'
import { layerWake, sleepCausesFor } from '../time'
import { layer } from './service'

// The engine's own Git (spec §7.7, §20.2): git on the engine's host, through the runner's allowlisted
// environment, each command's time limit counted in time awake. The daemon builds it once and gives it
// to every group that runs git.

/** Git on the engine's host, each command's time limit counted in time awake (§7.7). */
export const hostLayer = layer().pipe(
  Layer.provide(layerHost),
  Layer.provide(layerAwake),
  Layer.provide(layerWake),
  Layer.provide(Layer.suspend(() => sleepCausesFor(process.platform))),
)
