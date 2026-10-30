import type { DateTime, Effect, Stream } from 'effect'

import * as Attention from './features/attention/attention'
import * as Backlog from './features/backlog/backlog'
import * as Clock from './features/clock/clock'
import * as Connection from './features/connection/connection'
import * as History from './features/history/history'
import * as Keys from './features/keys/keys'
import * as Notifications from './features/notifications/notifications'
import * as Remotes from './features/remotes/remotes'
import * as RunView from './features/run-view/run-view'
import * as Sidebar from './features/sidebar/sidebar'
import * as SshPrompts from './features/ssh-prompts/ssh-prompts'
import * as Talks from './features/talks/talks'
import * as Titlebar from './features/titlebar/titlebar'
import * as Worker from './features/worker/worker'
import type { Pressed } from './keys'

// The streams the app listens to (spec §18.1, §18.5): every feature's, each subscribed only while a part
// that draws it is shown, listed here a line each in the order of their names (feature.ts). Each
// project's streams go through the engine holding it, while that engine is connected (engine-route.ts),
// and each stream's items go on once per animation frame, so a burst of patches costs one update.

/** What the subscriptions need from their host, injected so tests drive them. */
export interface SubscriptionEnvironment {
  /** Waits for the next animation frame. */
  readonly nextFrame: Effect.Effect<void>
  /** The keys going down in the window. */
  readonly keys: Stream.Stream<Pressed>
  /** The time now in the viewer's zone, about every second (clock.ts). */
  readonly ticks: Stream.Stream<DateTime.Zoned>
  /** Each engine port that replaces the one the connection took (engine-ports.ts). */
  readonly replacedEnginePorts: Stream.Stream<void>
}

export const makeSubscriptions = (environment: SubscriptionEnvironment) => ({
  ...Attention.subscriptions(environment),
  ...Backlog.subscriptions(environment),
  ...Clock.subscriptions(environment),
  ...Connection.subscriptions(environment),
  ...History.subscriptions(environment),
  ...Keys.subscriptions(environment),
  ...Notifications.subscriptions(environment),
  ...Remotes.subscriptions(environment),
  ...RunView.subscriptions(environment),
  ...Sidebar.subscriptions(environment),
  ...SshPrompts.subscriptions(),
  ...Talks.subscriptions(environment),
  ...Titlebar.subscriptions(environment),
  ...Worker.subscriptions(environment),
})
