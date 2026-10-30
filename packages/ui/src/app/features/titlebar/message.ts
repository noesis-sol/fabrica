import { Schema } from 'effect'

import { EngineProject } from '../../engine-project'
import { LoadItem, UsageItem, itemsOf } from '../../streams'

// The title bar's Messages (spec §18.3): the host's load, and the usage windows.

export const messages = {
  /** The host's load of the engine named `engine`, the scoped project's. */
  ReceivedLoad: { engine: Schema.String, items: itemsOf(LoadItem) },
  /** The usage windows of `project`'s provider account, the scoped project's. */
  ReceivedUsage: { project: EngineProject, items: itemsOf(UsageItem) },
}
