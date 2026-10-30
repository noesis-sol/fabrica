import { Option, Schema, Stream } from 'effect'
import { Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import {
  type AttentionPatch,
  type AttentionRequest,
  type Platform,
  ProjectId,
} from '@fabrica/contracts'

import * as Attention from '../../../console/attention'
import * as Sidebar from '../../../console/sidebar'
import * as TalkPanel from '../../../console/talk-panel'
import * as Review from '../../../screens/review'
import * as Talks from '../../../screens/talks'
import { scopeEngine, withEngineClient } from '../../engine-route'
import {
  type Handlers,
  type Return,
  type SubscriptionServices,
  andThen,
} from '../../feature'
import { perFrame } from '../../frame'
import { approvalKeyLabels } from '../../keys'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import { Screen } from '../../screen'
import { applyEngineAttention, joinedAttention, watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import * as ReviewFeature from '../review/review'
import { enterScreen, showScreen } from '../screen/screen'
import { requestAnswerTalk, stepTalkPanel, writeTalks } from '../talks/talks'
import type { messages } from './message'

// The attention column (spec §15.1, §18.3): the scope's open requests, every engine's kept apart and
// joined oldest first, the keys 1–9 that answer the drawn question, and each card's buttons.

const writeAttention = (model: Model, attention: Attention.Model): Model =>
  modifyFields(model, {
    console: parts => modifyFields(parts, { attention: () => attention }),
  })

const toAttentionMessage = (message: Attention.Message): Message =>
  Message.GotAttentionMessage({ message })

/** The attention column's Messages, folded into its submodel; a card's buttons open their screens. */
const foldAttention = Update.foldChild({
  update: Attention.update,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
  foldOutMessage: (outMessage: Attention.OutMessage) => (model: Model) =>
    Attention.OutMessage.match<Return>(outMessage, {
      // "Talk it through": the answer talk opened on the question's project, shown on the Talks screen.
      OpenedAnswerTalk: ({ project }) =>
        requestAnswerTalk(
          writeTalks(
            showScreen(model, Screen.Talks()),
            Talks.showConsoleTalk(model.screens.talks, 'answer'),
          ),
          Option.some(project),
        ),
      // A set-aside ticket's Review opens its branch diff (§18.3).
      OpenedReview: ({ project, ticket }) =>
        ReviewFeature.step(showScreen(model, Screen.Review()), review =>
          Review.openTicket(review, { project, ticket }),
        ),
      OpenedSession: ({ project, ticket }) =>
        enterScreen(model, Screen.Worker({ project, ticket })),
    }),
})

/** The attention column kept in step with the Model's requests, after they change. */
export const foldRequests = Update.foldChild({
  update: Attention.receivedRequests,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
})

/** A key 1–9, applied by the attention column to the request it names. */
const foldAnswerKey = Update.foldChild({
  update: Attention.pressedOptionKey,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
})

/**
 * The scope's attention requests now `engineAttention`, each engine's kept apart: the column shows them
 * joined, and the answer talk follows their open questions.
 */
const showAttention = (
  model: Model,
  engineAttention: Model['engineAttention'],
): Return =>
  andThen(
    foldRequests(
      modifyFields(model, {
        engineAttention: () => engineAttention,
        attention: () => joinedAttention(engineAttention),
      }),
      engineAttention,
    ),
    shown =>
      stepTalkPanel(shown, talkPanel =>
        TalkPanel.receivedQuestions(
          talkPanel,
          TalkPanel.openQuestions(engineAttention),
        ),
      ),
  )

/**
 * The attention column keeps the requests of the engines its watch follows alone: an engine that failed,
 * stopped, was refused or is connecting again (no longer live) has its requests dropped, since none can
 * be answered there; its stream sends them afresh once it is connected again.
 */
export const dropLostAttention = (model: Model): Return => {
  const kept = model.engineAttention.filter(entry =>
    RemoteEngines.isEngineLive(model, entry.engine),
  )
  return kept.length === model.engineAttention.length
    ? { model }
    : showAttention(model, kept)
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotAttentionMessage: ({ message }) => foldAttention(model, message),
  PressedAnswerKey: ({ key, place }) => foldAnswerKey(model, { key, place }),
  PressedApprovalKey: ({ key, decision }) =>
    Option.match(
      Attention.approvalKeyMessage(model.console.attention, {
        key,
        decision,
      }),
      {
        onNone: () => ({ model }),
        onSome: message => foldAttention(model, message),
      },
    ),
  ReceivedAttention: ({ engine, items }) => {
    // A project's scope shows its own engine's requests alone, whatever an engine's stream of the
    // scope before sends after it.
    if (Option.isSome(model.scope) && engine !== scopeEngine(model.scope)) {
      return { model }
    }
    const engineAttention = applyEngineAttention(
      model.engineAttention,
      engine,
      items,
    )
    // A patch before the engine's first snapshot changes nothing.
    return engineAttention === model.engineAttention
      ? { model }
      : showAttention(model, engineAttention)
  },
})

/**
 * The attention column, a Submodel: given the scope's requests, the time, the connection and, under All
 * projects, each card's project's chip (§18.3).
 */
export const attentionPart = (
  attention: Attention.Model,
  requests: Model['engineAttention'],
  focused: Model['focusedRequest'],
  now: Model['now'],
  live: boolean,
  scope: Model['scope'],
  sidebar: Sidebar.Model,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'attention',
    model: attention,
    view: Attention.view,
    viewInputs: {
      requests,
      focused,
      now,
      live,
      chip: project =>
        Option.isNone(scope)
          ? Sidebar.projectChip(sidebar, project)
          : Option.none(),
      approvalKeys: approvalKeyLabels(platform),
    },
    toParentMessage: message => Message.GotAttentionMessage({ message }),
  })

/** The open attention requests on the engine named `engine`, of one of its projects or every one. */
export const attentionMessages = (
  client: EngineClientShape,
  {
    engine,
    project,
  }: { readonly engine: string; readonly project: Option.Option<ProjectId> },
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<AttentionRequest>, typeof AttentionPatch.Type>(client)(
    resume => client.rpc['attention.watch']({ project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedAttention({ engine, items })),
    Stream.catch(() => Stream.empty),
  )

/**
 * The engines whose attention requests the console shows: the scoped project's, or under All projects
 * every one connected now.
 */
const attentionEngines = (model: Model): ReadonlyArray<string> =>
  Option.match(model.scope, {
    onSome: ({ engine }) =>
      RemoteEngines.isEngineLive(model, engine) ? [engine] : [],
    onNone: () => RemoteEngines.liveEngines(model),
  })

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    // The scoped project's requests on its engine, or under All projects every connected engine's.
    attention: entry(
      {
        engines: Schema.Array(Schema.String),
        project: Schema.Option(ProjectId),
      },
      {
        modelToDependencies: model => ({
          engines: attentionEngines(model),
          project: Option.map(model.scope, scoped => scoped.project),
        }),
        dependenciesToStream: ({ engines, project }) =>
          Stream.mergeAll(
            engines.map(engine =>
              withEngineClient(engine, client =>
                attentionMessages(client, { engine, project }, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
  }))
