import { Option } from 'effect'
import { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as Stats from '../../../console/stats'
import type { Handlers, Return } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import { requestAnswerTalk } from '../talks/talks'
import type { messages } from './message'

// The stats row (spec §18.3): the scope's figures and its run controls.

/**
 * The stats row's Messages, folded into its submodel; a run it started is watched afresh, and an
 * overnight pre-flight's questions opened in the answer talk.
 */
const foldStats = Update.foldChild({
  update: Stats.update,
  read: (model: Model) => Option.some(model.console.stats),
  write: (model, stats) =>
    modifyFields(model, {
      console: parts => modifyFields(parts, { stats: () => stats }),
    }),
  toParentMessage: (message: Stats.Message): Message =>
    Message.GotStatsMessage({ message }),
  foldOutMessage: (outMessage: Stats.OutMessage) => (model: Model) =>
    Stats.OutMessage.match<Return>(outMessage, {
      StartedRun: ({ project }) => ({
        model: Option.contains(model.scope, project)
          ? modifyFields(model, { runWatch: watch => watch + 1 })
          : model,
      }),
      AnsweringQuestions: ({ project }) =>
        requestAnswerTalk(model, Option.some(project)),
    }),
})

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotStatsMessage: ({ message }) => foldStats(model, message),
})

/**
 * The stats row, a Submodel: given the scope, the connection, the scoped run (under All projects every
 * project's run going), the time and the requests.
 */
const statsPart = (
  stats: Stats.Model,
  inputs: Stats.ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'stats',
    model: stats,
    view: Stats.view,
    viewInputs: inputs,
    toParentMessage: message => Message.GotStatsMessage({ message }),
  })

export const lazyStatsPart = (
  stats: Stats.Model,
  project: Model['scope'],
  live: boolean,
  run: Model['runView'],
  runViews: Model['runViews'],
  now: Model['now'],
  attention: Model['attention'],
  h: HtmlBuilder<Message>,
): Html =>
  statsPart(
    stats,
    {
      project,
      live,
      run,
      runs: runViews.map(({ view }) => view),
      now,
      attention,
    },
    h,
  )
