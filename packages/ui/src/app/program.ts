import { Effect, Layer } from 'effect'
import { ManagedResource, type Runtime } from 'foldkit'

import {
  AttemptFailure,
  ConnectionRequirements,
  EngineConnection,
  type EngineConnectionService,
  attemptFailure,
  connect,
  connectionRequirements,
} from './connection'
import { AppHost, type AppHostShape } from './host'
import { Message } from './message'
import { Flags, Model, initialModel } from './model'
import { type NotifierShape, layerNotifier } from './notifier'
import {
  type SubscriptionEnvironment,
  makeSubscriptions,
} from './subscriptions'
import { type ThemeHostShape, layerThemeHost } from './theme-host'
import { update } from './update'
import { view } from './view'

// The program the entries run (spec §18.1): the Model, its update and view, the engine connection as
// a ManagedResource, the subscriptions, the notifier and the app around the renderer as resources,
// given what they need of their host, injected so tests run them against a test engine and their own
// frames and keys.

/** What the program needs from its host. */
export interface Environment extends SubscriptionEnvironment {
  /** The connection process's newest port, once the preload has handed one over. */
  readonly enginePort: Effect.Effect<MessagePort>
  /** The app's notifications (§18.5): through the preload, or none without it. */
  readonly notifier: NotifierShape
  /** The app around the renderer: the desktop app's preload, or none in a browser. */
  readonly host: AppHostShape
  /** Where the theme is shown and kept: the window the renderer runs in. */
  readonly themeHost: ThemeHostShape
}

/** How the app names itself in its hello. */
export const clientName = 'Fabrica'

export const init: Runtime.ApplicationInit<Model, Message, Flags> = flags => ({
  model: initialModel(flags),
})

export const makeManagedResources = (
  environment: Environment,
): ManagedResource.ManagedResources<Model, Message, EngineConnectionService> =>
  ManagedResource.make<Model, Message>()(entry => ({
    engine: entry(ConnectionRequirements, {
      resource: EngineConnection,
      modelToMaybeRequirements: connectionRequirements,
      acquire: ({ release }) =>
        connect({
          enginePort: environment.enginePort,
          client: { name: clientName, kind: 'app', release },
        }),
      release: () => Effect.void,
      onAcquired: session => Message.ConnectedToEngine(session.hello),
      onReleased: () => Message.ReleasedEngine(),
      onAcquireError: error =>
        AttemptFailure.$match(attemptFailure(error), {
          Refused: ({ mismatch }) =>
            Message.RefusedByEngine({
              client: mismatch.client,
              engine: mismatch.engine,
              update: mismatch.update,
            }),
          Unreachable: ({ reason }) => Message.FailedToConnect({ reason }),
        }),
    }),
  }))

export const program = (environment: Environment) => ({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions: makeSubscriptions(environment),
  resources: Layer.mergeAll(
    layerNotifier(environment.notifier),
    Layer.succeed(AppHost, environment.host),
    layerThemeHost(environment.themeHost),
  ),
  managedResources: makeManagedResources(environment),
})
