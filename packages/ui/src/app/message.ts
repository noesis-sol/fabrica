import { defineMessageUnion } from 'foldkit/message'

import * as Attention from './features/attention/message'
import * as Backlog from './features/backlog/message'
import * as Clock from './features/clock/message'
import * as Connection from './features/connection/message'
import * as Engines from './features/engines/message'
import * as History from './features/history/message'
import * as Insights from './features/insights/message'
import * as Keys from './features/keys/message'
import * as Notifications from './features/notifications/message'
import * as Palette from './features/palette/message'
import * as Remotes from './features/remotes/message'
import * as Review from './features/review/message'
import * as RunView from './features/run-view/message'
import * as Scope from './features/scope/message'
import * as Screen from './features/screen/message'
import * as Settings from './features/settings/message'
import * as Sidebar from './features/sidebar/message'
import * as SshPrompts from './features/ssh-prompts/message'
import * as Stats from './features/stats/message'
import * as Talks from './features/talks/message'
import * as Theme from './features/theme/message'
import * as Titlebar from './features/titlebar/message'
import * as Worker from './features/worker/message'

// The root's Messages (spec §18.1): every feature's, each feature's in its own `features/<name>/message.ts`
// (feature.ts), listed here a line each in the order of their names.

export const Message = defineMessageUnion({
  ...Attention.messages,
  ...Backlog.messages,
  ...Clock.messages,
  ...Connection.messages,
  ...Engines.messages,
  ...History.messages,
  ...Insights.messages,
  ...Keys.messages,
  ...Notifications.messages,
  ...Palette.messages,
  ...Remotes.messages,
  ...Review.messages,
  ...RunView.messages,
  ...Scope.messages,
  ...Screen.messages,
  ...Settings.messages,
  ...Sidebar.messages,
  ...SshPrompts.messages,
  ...Stats.messages,
  ...Talks.messages,
  ...Theme.messages,
  ...Titlebar.messages,
  ...Worker.messages,
})
export type Message = typeof Message.Type
