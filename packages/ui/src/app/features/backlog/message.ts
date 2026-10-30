import * as Backlog from '../../../screens/backlog'
import { EngineProject } from '../../engine-project'
import { BacklogItem, itemsOf } from '../../streams'

// The Backlog screen's Messages (spec §18.4): its own, and the scoped project's tickets.

export const messages = {
  /** A Message of the Backlog screen's. */
  GotBacklogMessage: { message: Backlog.Message },
  ReceivedBacklog: { project: EngineProject, items: itemsOf(BacklogItem) },
}
