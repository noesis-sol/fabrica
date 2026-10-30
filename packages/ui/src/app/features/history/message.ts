import * as History from '../../../console/history'
import { EngineProject } from '../../engine-project'
import { EventsItem, itemsOf } from '../../streams'

// History's Messages (spec §18.3): its own, and the events of the runs it shows.

export const messages = {
  GotHistoryMessage: { message: History.Message },
  ReceivedEvents: { project: EngineProject, items: itemsOf(EventsItem) },
}
