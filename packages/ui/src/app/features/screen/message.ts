import { TicketId } from '@fabrica/contracts'

import { EngineProject } from '../../engine-project'
import { Screen } from '../../screen'

// The screens' Messages (spec §18.3, §18.4): a screen asked for, a worker's view, and the sidebar's
// "+ Add project".

export const messages = {
  RequestedScreen: { screen: Screen },
  /** The worker view of a ticket of a run in the scope, on its project: under All projects, one of many. */
  RequestedWorker: { project: EngineProject, ticket: TicketId },
  /** The sidebar's "+ Add project": the engines screen's add-project flow (§10.1). */
  RequestedAddProject: {},
}
