import { Effect, Option, Stream } from 'effect'
import { Subscription } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { KeepAnswer, KnownEnginesAnswer } from '@fabrica/client'
import { ReleaseVersion } from '@fabrica/contracts'

import * as Engines from '../../../screens/engines'
import { Connection, clientName } from '../../connection'
import {
  EngineSessions,
  type EngineSessionsShape,
  scopeEngine,
} from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { AppHost, type AppHostShape } from '../../host'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import { Screen } from '../../screen'
import type { SubscriptionEnvironment } from '../../subscriptions'
import * as EnginesFeature from '../engines/engines'
import { reopenScreen } from '../screen/screen'
import { projectMessages } from '../sidebar/sidebar'
import type { messages } from './message'

// The known engines on other hosts (spec §9.1): the app's state's list, and each one's connection, kept
// while the others change, with its project rows.

/** The known engine named `name`'s connection now `connection`. */
const remoteConnectionNow = (
  model: Model,
  name: string,
  connection: Connection,
): Model =>
  modifyFields(model, {
    remotes: remotes =>
      RemoteEngines.connectionChanged(remotes, name, connection),
  })

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  LoadedKnownEngines: ({ answer }) => ({
    model: modifyFields(model, {
      remotes: remotes =>
        KnownEnginesAnswer.match(answer, {
          Read: ({ engines }) => RemoteEngines.loaded(remotes, engines),
          Failed: ({ reason }) =>
            modifyFields(remotes, {
              problem: () =>
                Option.some(
                  `The app’s known engines couldn’t be read: ${reason}`,
                ),
            }),
        }),
    }),
  }),
  CompletedKeepEngine: ({ name, answer }) => ({
    model: KeepAnswer.match(answer, {
      Kept: () => model,
      Failed: ({ reason }) =>
        modifyFields(model, {
          remotes: remotes =>
            modifyFields(remotes, {
              problem: () =>
                Option.some(
                  `${name} couldn’t be kept among the app’s engines: ${reason}`,
                ),
            }),
        }),
    }),
  }),
  ConnectedToRemote: ({ name, engine, release, protocol }) => {
    const connected = RemoteEngines.connected(model.remotes, {
      name,
      hello: Connection.Up({ engine, release, protocol }),
    })
    // The screen shown asks again what it shows of the engine just reached: the Engines screen its
    // status and credentials, another screen its scope's, where the scope is that engine's.
    const reached = modifyFields(model, { remotes: () => connected.model })
    const reopened = Screen.guards.Engines(model.screen)
      ? EnginesFeature.step(reached, engines => Engines.opened(engines, [name]))
      : scopeEngine(model.scope) === name
        ? reopenScreen(reached)
        : { model: reached }
    return {
      ...reopened,
      commands: [
        ...(reopened.commands ?? []),
        ...Option.match(connected.keep, {
          onNone: () => [],
          onSome: engine => [RemoteEngines.KeepEngine({ engine })],
        }),
      ],
    }
  },
  LostRemote: ({ name }) => ({
    model: remoteConnectionNow(model, name, Connection.Down()),
  }),
  FailedToConnectRemote: ({ name, reason }) => ({
    model: remoteConnectionNow(model, name, Connection.Failed({ reason })),
  }),
  StoppedConnectingRemote: ({ name, reason }) => ({
    model: remoteConnectionNow(model, name, Connection.Stopped({ reason })),
  }),
  RefusedByRemote: ({ name, client, engine, update }) => ({
    model: remoteConnectionNow(
      model,
      name,
      Connection.Refused({ client, engine, update }),
    ),
  }),
})

/** What the app says where no app is around the renderer to reach its known engines. */
export const noAppToReachEngines =
  'only the desktop app reaches engines on other hosts'

/**
 * A known engine on another host's connection, attempt after attempt, with its project rows, its
 * session held by its name while it is connected; its ports come from the app around the renderer.
 */
export const remoteConnection =
  ({
    host,
    sessions,
    release,
    nextFrame,
  }: {
    readonly host: AppHostShape
    readonly sessions: EngineSessionsShape
    readonly release: ReleaseVersion
    readonly nextFrame: SubscriptionEnvironment['nextFrame']
  }) =>
  ({ name, address }: RemoteEngines.Attempt): Stream.Stream<Message> =>
    Option.match(host.enginePort, {
      onNone: () =>
        Stream.make(
          Message.StoppedConnectingRemote({
            name,
            reason: noAppToReachEngines,
          }),
        ),
      onSome: port =>
        RemoteEngines.remoteEngineMessages({
          name,
          port: port(address),
          client: { name: clientName, kind: 'app', release },
          streams: session => projectMessages(session, name, nextFrame),
          keep: session => sessions.keep(name, session),
        }),
    })

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    // Each known engine on another host keeps its connection while the others change (remote-engines.ts).
    remotes: entry(
      { engines: RemoteEngines.Attempts, release: ReleaseVersion },
      {
        modelToDependencies: model => ({
          engines: RemoteEngines.attempts(model.remotes),
          release: model.release,
        }),
        dependenciesToStream: ({ engines, release }) =>
          Stream.fromEffectDrain(
            Effect.gen(function* () {
              const host = yield* AppHost
              const sessions = yield* EngineSessions
              const connections = yield* RemoteEngines.RemoteConnections
              yield* connections.hold(
                engines,
                remoteConnection({ host, sessions, release, nextFrame }),
              )
            }),
          ),
      },
    ),
    remoteMessages: Subscription.persistentEntry(
      Stream.unwrap(
        Effect.map(
          RemoteEngines.RemoteConnections,
          connections => connections.messages,
        ),
      ),
    ),
  }))
