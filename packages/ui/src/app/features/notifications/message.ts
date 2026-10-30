import { Schema } from 'effect'

import { ProjectId, RunId } from '@fabrica/contracts'

import { NotificationTarget } from '../../notify'
import { AttentionItem, EventsItem, itemsOf } from '../../streams'

// The app's notifications' Messages (spec §18.5): what they are told of, and a click on one.

export const messages = {
  /** Every project's attention requests on the engine named `engine`, read for those to notify (§18.5). */
  ReceivedAttentionToNotify: {
    engine: Schema.String,
    items: itemsOf(AttentionItem),
  },
  /** A run's events on the engine named `engine`, read for those to notify. */
  ReceivedRunEvents: {
    engine: Schema.String,
    project: ProjectId,
    run: RunId,
    items: itemsOf(EventsItem),
  },
  /** A run's events ended: the run is over, or can't be read. */
  EndedRunEvents: { engine: Schema.String, project: ProjectId, run: RunId },
  CompletedShowNotification: {},
  /** A notification was clicked: the console focuses its target. */
  ClickedNotification: { target: NotificationTarget },
}
