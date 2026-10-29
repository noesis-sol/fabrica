import { Effect } from 'effect'
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
import { Message } from './message'
import { Flags, Model, initialModel } from './model'
import { type NotifierShape, layerNotifier } from './notifier'
import {
  type SubscriptionEnvironment,
  makeSubscriptions,
} from './subscriptions'
import { update } from './update'
import { view } from './view'

// The program the entries run (spec §18.1): the Model, its update and view, the engine connection as
// a ManagedResource, the subscriptions, and the notifier as a resource, given what they need of their
// host, injected so tests run them against a test engine and their own frames and keys.

/** What the program needs from its host. */
export interface Environment extends SubscriptionEnvironment {
  /** The connection process's port, once the preload has handed it over. */
  readonly enginePort: Effect.Effect<MessagePort>
  /** The app's notifications (§18.5): through the preload, or none without it. */
  readonly notifier: NotifierShape
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
  resources: layerNotifier(environment.notifier),
  managedResources: makeManagedResources(environment),
})
