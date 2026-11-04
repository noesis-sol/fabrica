import * as History from '../../../console/history'
import { EngineProject } from '../../engine-project'
import { EventsItem, itemsOf } from '../../streams'

// History's Messages (spec §18.3): its own, the events of the runs it shows, and the run talk's actions
// with no run going (§15.4).

export const messages = {
  GotHistoryMessage: { message: History.Message },
  ReceivedEvents: { project: EngineProject, items: itemsOf(EventsItem) },
  ReceivedTalkActions: { project: EngineProject, items: itemsOf(EventsItem) },
}
