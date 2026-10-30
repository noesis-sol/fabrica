import { Array, Effect, Option, Schema, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import { TalkId, type TranscriptEntry } from '@fabrica/contracts'

import * as Sidebar from '../../../console/sidebar'
import * as TalkPanel from '../../../console/talk-panel'
import * as Talks from '../../../screens/talks'
import { isLive } from '../../connection'
import { EngineProject } from '../../engine-project'
import { type EngineServices, withEngineClient } from '../../engine-route'
import type { Handlers, Return, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import { watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The talks (spec §15.3, §15.4): the console's talk panel, with the scope's run talk opened as the scope
// changes and the answer talk, and the Talks screen; every talk either holds has its transcript watched.

const writeTalkPanel = (model: Model, talkPanel: TalkPanel.Model): Model =>
  modifyFields(model, {
    console: parts => modifyFields(parts, { talkPanel: () => talkPanel }),
  })

/** The talk panel's own Model changed, and its Commands lifted, by `step`. */
export const stepTalkPanel = (
  model: Model,
  step: (
    talkPanel: TalkPanel.Model,
  ) => Update.Return<TalkPanel.Model, TalkPanel.Message, EngineServices>,
): Return => {
  const stepped = step(model.console.talkPanel)
  return {
    model: writeTalkPanel(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotTalkPanelMessage({ message }),
    ),
  }
}

export const writeTalks = (model: Model, talks: Talks.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { talks: () => talks }),
  })

/** The Talks screen's own Model changed, and its Commands lifted, by `step`. */
const stepTalks = (
  model: Model,
  step: (
    talks: Talks.Model,
  ) => Update.Return<Talks.Model, Talks.Message, EngineServices>,
): Return => {
  const stepped = step(model.screens.talks)
  return {
    model: writeTalks(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotTalksMessage({ message }),
    ),
  }
}

/** The talk panel for the scope: its run talk, and an answer talk only for a project in scope. */
export const scopeTalkPanel = (model: Model): Return =>
  stepTalkPanel(model, talkPanel => TalkPanel.scoped(talkPanel, model.scope))

/** The answer talk opened by the maintainer, on `project` or the first with questions. */
export const requestAnswerTalk = (
  model: Model,
  project: Option.Option<EngineProject>,
): Return =>
  stepTalkPanel(model, talkPanel =>
    TalkPanel.requestedAnswerTalk(talkPanel, project),
  )

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotTalkPanelMessage: ({ message }) =>
    stepTalkPanel(model, talkPanel =>
      TalkPanel.update(talkPanel, message, {
        scope: model.scope,
        projects: TalkPanel.projectNames(model.console.sidebar),
      }),
    ),
  GotTalksMessage: ({ message }) =>
    stepTalks(model, talks => Talks.update(talks, message)),
  RequestedAnswerTalk: () => requestAnswerTalk(model, Option.none()),
  ReceivedTranscript: ({ talk, items }) => ({
    model: writeTalks(
      writeTalkPanel(
        model,
        TalkPanel.receivedTranscript(model.console.talkPanel, talk, items),
      ),
      Talks.receivedTranscript(model.screens.talks, talk, items),
    ),
  }),
  EndedTranscript: ({ talk }) => ({
    model: writeTalks(
      writeTalkPanel(
        model,
        TalkPanel.endedTranscript(model.console.talkPanel, talk),
      ),
      Talks.endedTranscript(model.screens.talks, talk),
    ),
  }),
})

/** The talk panel, a Submodel: given the scope, the connection and the projects by name. */
export const talkPanelPart = (
  talkPanel: TalkPanel.Model,
  scope: Model['scope'],
  live: boolean,
  sidebar: Sidebar.Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'talk-panel',
    model: talkPanel,
    view: TalkPanel.view,
    viewInputs: { scope, live, projects: TalkPanel.projectNames(sidebar) },
    toParentMessage: message => Message.GotTalkPanelMessage({ message }),
  })

/** The Talks screen, with the console's run and answer talks. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'talks',
    view: Talks.view,
    model: model.screens.talks,
    viewInputs: {
      scope: model.scope,
      live: isLive(model.connection),
      run: TalkPanel.runTalk(model.console.talkPanel),
      answer: TalkPanel.answerTalk(model.console.talkPanel),
      projectName: project =>
        Option.getOrElse(
          Sidebar.projectName(model.console.sidebar, project),
          () => project.project,
        ),
    },
    toParentMessage: message => Message.GotTalksMessage({ message }),
  })

/** A talk's transcript, a frame's entries at a time; its end, when the engine no longer has the talk. */
export const transcriptMessages = (
  client: EngineClientShape,
  talk: TalkId,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<TranscriptEntry>, ReadonlyArray<TranscriptEntry>>(
    client,
  )(resume => client.rpc['talk.watchTranscript']({ talk, resume })).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedTranscript({ talk, items })),
    Stream.catch(() => Stream.empty),
    Stream.concat(Stream.make(Message.EndedTranscript({ talk }))),
  )

/** The talks the app holds, the console's and the Talks screen's, each once, with its project's engine, while it is connected. */
const heldTalks = (
  model: Model,
): ReadonlyArray<{ readonly engine: string; readonly talk: TalkId }> =>
  Array.dedupeWith(
    [
      ...TalkPanel.heldTalks(model.console.talkPanel),
      ...Talks.heldTalks(model.screens.talks),
    ].map(({ project, talk }) => ({ engine: project.engine, talk })),
    (first, second) => first.talk === second.talk,
  ).filter(({ engine }) => RemoteEngines.isEngineLive(model, engine))

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    runTalk: entry(
      { project: Schema.Option(EngineProject) },
      {
        modelToDependencies: model => ({
          project: RemoteEngines.liveScope(model),
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              Stream.fromEffect(
                Effect.map(TalkPanel.openRunTalk(project), message =>
                  Message.GotTalkPanelMessage({ message }),
                ),
              ),
          }),
      },
    ),
    transcripts: entry(
      {
        talks: Schema.Array(
          Schema.Struct({ engine: Schema.String, talk: TalkId }),
        ),
      },
      {
        modelToDependencies: model => ({ talks: heldTalks(model) }),
        dependenciesToStream: ({ talks }) =>
          Stream.mergeAll(
            talks.map(({ engine, talk }) =>
              withEngineClient(engine, client =>
                transcriptMessages(client, talk, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
  }))
