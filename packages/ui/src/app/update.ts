import { type Return, type Root, andThen } from './feature'
import * as Attention from './features/attention/attention'
import * as Backlog from './features/backlog/backlog'
import * as Clock from './features/clock/clock'
import * as Connection from './features/connection/connection'
import * as Engines from './features/engines/engines'
import * as History from './features/history/history'
import * as Insights from './features/insights/insights'
import * as Keys from './features/keys/keys'
import * as Notifications from './features/notifications/notifications'
import * as Palette from './features/palette/palette'
import * as Remotes from './features/remotes/remotes'
import * as Review from './features/review/review'
import * as RunView from './features/run-view/run-view'
import * as Scope from './features/scope/scope'
import * as Screen from './features/screen/screen'
import * as Settings from './features/settings/settings'
import * as Sidebar from './features/sidebar/sidebar'
import * as SshPrompts from './features/ssh-prompts/ssh-prompts'
import * as Stats from './features/stats/stats'
import * as Talks from './features/talks/talks'
import * as Theme from './features/theme/theme'
import * as Titlebar from './features/titlebar/titlebar'
import * as Worker from './features/worker/worker'
import { Message } from './message'
import type { Model } from './model'

// The root's update (spec §18.1): each Message to its feature's branch, every feature's listed here a
// line each in the order of their names (feature.ts); after every one, the attention column drops the
// requests of the engines no longer connected.

const root: Root = { update: (model, message) => update(model, message) }

const receive = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ...Attention.update(model),
    ...Backlog.update(model),
    ...Clock.update(model),
    ...Connection.update(model),
    ...Engines.update(model),
    ...History.update(model),
    ...Insights.update(model),
    ...Keys.update(model, root),
    ...Notifications.update(model),
    ...Palette.update(model, root),
    ...Remotes.update(model),
    ...Review.update(model),
    ...RunView.update(model),
    ...Scope.update(model),
    ...Screen.update(model),
    ...Settings.update(model),
    ...Sidebar.update(model),
    ...SshPrompts.update(model),
    ...Stats.update(model),
    ...Talks.update(model),
    ...Theme.update(model),
    ...Titlebar.update(model),
    ...Worker.update(model),
  })

export const update = (model: Model, message: Message): Return =>
  andThen(receive(model, message), Attention.dropLostAttention)
