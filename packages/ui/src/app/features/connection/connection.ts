import { Effect, Option, Redacted, Schema, Stream } from 'effect'
import { Command, Subscription } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import { type EngineClientShape, Link } from '@fabrica/client'

import * as Sidebar from '../../../console/sidebar'
import * as TalkPanel from '../../../console/talk-panel'
import * as Talks from '../../../screens/talks'
import {
  Connection,
  isLive,
  localEngineName,
  retryAfter,
} from '../../connection'
import { withEngineClient } from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import * as SshPrompts from '../../ssh-prompts'
import type { SubscriptionEnvironment } from '../../subscriptions'
import { foldRequests } from '../attention/attention'
import * as BacklogFeature from '../backlog/backlog'
import { reopenScreen } from '../screen/screen'
import type { messages } from './message'

// The connection to this machine's engine (spec §8.2, §9.1): its lifecycle, attempt after attempt, the
// engine ports main hands the page, the client's link, and the notice said while it isn't up.

/** Waits before the next connection attempt. */
export const WaitToReconnect = Command.define('WaitToReconnect', {
  messages: [Message.WaitedToReconnect],
  execute: Effect.as(Effect.sleep(retryAfter), Message.WaitedToReconnect()),
})

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ConnectedToEngine: ({ engine, release, protocol }) => {
    // The notices ssh gave as it connected are done with.
    const notices = SshPrompts.notices(model.sshPrompts)
    const hello = Connection.Up({ engine, release, protocol })
    // The engine in WSL2 Add engine had main reach is kept, for main to reach at the next start.
    const inWsl = RemoteEngines.connectedInWsl(model.remotes, hello)
    const connected = modifyFields(model, {
      connection: () => hello,
      remotes: () => inWsl.model,
      sshPrompts: prompts => notices.reduce(SshPrompts.drop, prompts),
    })
    // The screen shown asks again what it shows of the engine just reached.
    const reopened = reopenScreen(connected)
    return {
      ...reopened,
      commands: [
        ...(reopened.commands ?? []),
        ...notices.map(id =>
          SshPrompts.AnswerSshPrompt({
            id,
            reply: 'Declined',
            secret: Redacted.make(''),
          }),
        ),
        ...Option.match(inWsl.keep, {
          onNone: () => [],
          onSome: kept => [RemoteEngines.KeepEngine({ engine: kept })],
        }),
      ],
    }
  },
  LostEngine: () => ({
    model: modifyFields(model, { connection: () => Connection.Down() }),
  }),
  ReleasedEngine: () =>
    foldRequests(
      modifyFields(BacklogFeature.opened(model), {
        runView: () => Option.none(),
        runViews: () => [],
        events: () => [],
        attention: () => Option.none(),
        engineAttention: () => [],
        backlog: () => Option.none(),
        load: () => Option.none(),
        usage: () => Option.none(),
        console: parts =>
          modifyFields(parts, {
            sidebar: () => Sidebar.init(),
            talkPanel: () => TalkPanel.init(),
          }),
        screens: screens => modifyFields(screens, { talks: Talks.init }),
      }),
      [],
    ),
  FailedToConnect: ({ reason }) => ({
    model: modifyFields(model, {
      connection: () => Connection.Failed({ reason }),
    }),
    commands: [WaitToReconnect()],
  }),
  StoppedConnecting: ({ reason }) => ({
    model: modifyFields(model, {
      connection: () => Connection.Stopped({ reason }),
    }),
  }),
  RequestedReconnect: () => ({
    model: Connection.guards.Stopped(model.connection)
      ? modifyFields(model, {
          attempt: attempt => attempt + 1,
          connection: () => Connection.Connecting(),
        })
      : model,
  }),
  RefusedByEngine: ({ client, engine, update }) => ({
    model: modifyFields(model, {
      connection: () => Connection.Refused({ client, engine, update }),
    }),
  }),
  WaitedToReconnect: () => ({
    model: modifyFields(model, {
      attempt: attempt => attempt + 1,
      connection: () => Connection.Connecting(),
    }),
  }),
  // The connection is acquired again over the new port; one refused waits for an update still, and
  // one stopped for the user.
  ReplacedEnginePort: () => ({
    model:
      Connection.guards.Refused(model.connection) ||
      Connection.guards.Stopped(model.connection)
        ? model
        : modifyFields(model, {
            attempt: attempt => attempt + 1,
            connection: () => Connection.Connecting(),
          }),
  }),
})

/** The connection's state, said while it isn't up. */
const connectionNotice = (model: Model): Option.Option<string> =>
  Connection.match(model.connection, {
    Connecting: () => Option.some('Connecting to the engine…'),
    Up: () => Option.none(),
    Down: () => Option.some('Lost the engine; reconnecting…'),
    Failed: ({ reason }) =>
      Option.some(`Couldn't reach the engine (${reason}); trying again.`),
    Stopped: ({ reason }) =>
      Option.some(`Couldn't reach the engine: ${reason}.`),
    Refused: ({ update }) =>
      Option.some(
        update === 'client'
          ? 'This app is too old for the engine: update the app.'
          : 'The engine is too old for this app: update the engine.',
      ),
  })

/** The connection's notice; one stopped offers to try again. */
export const notice = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(connectionNotice(model), {
    onNone: () => h.empty,
    onSome: text =>
      h.p(
        [
          h.Role('status'),
          h.Class('rounded-card border border-line px-12 py-6 text-xs'),
        ],
        [
          text,
          ...(Connection.guards.Stopped(model.connection)
            ? [
                ' ',
                h.button(
                  [
                    h.Type('button'),
                    h.OnClick(Message.RequestedReconnect()),
                    h.Class(
                      'rounded-button border border-line px-8 py-2 text-xs text-fg',
                    ),
                  ],
                  ['Try again'],
                ),
              ]
            : []),
        ],
      ),
  })

const linkMessage = Link.$match({
  Up: ({ hello }) =>
    Message.ConnectedToEngine({
      engine: hello.engine,
      release: hello.release,
      protocol: hello.protocol,
    }),
  Down: () => Message.LostEngine(),
  // The client stopped reconnecting: the connection is tried again, with a client of its own.
  Lost: () =>
    Message.FailedToConnect({ reason: 'the client stopped reconnecting' }),
  Refused: ({ mismatch }) =>
    Message.RefusedByEngine({
      client: mismatch.client,
      engine: mismatch.engine,
      update: mismatch.update,
    }),
})

/** Each change of the client's link. */
export const linkMessages = (
  client: EngineClientShape,
): Stream.Stream<Message> => Stream.map(client.links, linkMessage)

export const subscriptions = ({
  replacedEnginePorts,
}: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    enginePort: Subscription.persistentEntry(
      Stream.map(replacedEnginePorts, () => Message.ReplacedEnginePort()),
    ),
    link: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live ? withEngineClient(localEngineName, linkMessages) : Stream.empty,
      },
    ),
  }))
