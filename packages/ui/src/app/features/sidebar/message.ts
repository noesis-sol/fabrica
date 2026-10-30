import { Schema } from 'effect'

import { EngineId, ProjectStatusItem } from '@fabrica/contracts'

import { itemsOf } from '../../streams'

// The sidebar's Messages (spec §18.3): each engine's project rows.

export const messages = {
  /** An engine's project rows, for the sidebar; `name` is the engine's, as the app knows it. */
  ReceivedProjects: {
    engine: EngineId,
    name: Schema.String,
    items: itemsOf(ProjectStatusItem),
  },
}
