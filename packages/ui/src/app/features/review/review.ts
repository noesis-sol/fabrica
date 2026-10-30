import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as Review from '../../../screens/review'
import type { Handlers, Return } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import type { messages } from './message'

// The Review screen (spec §18.4): the scope's report, log and diff, or a set-aside ticket's.

const writeReview = (model: Model, review: Review.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { review: () => review }),
  })

const foldReview = Update.foldChild({
  update: Review.update,
  read: (model: Model) => Option.some(model.screens.review),
  write: writeReview,
  toParentMessage: (message: Review.Message) =>
    Message.GotReviewMessage({ message }),
})

/** The Review screen's own Model changed, and its Commands lifted, by `step`. */
export const step = (
  model: Model,
  stepReview: (
    review: Review.Model,
  ) => Update.Return<Review.Model, Review.Message, Review.Requires>,
): Return => {
  const stepped = stepReview(model.screens.review)
  return {
    model: writeReview(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotReviewMessage({ message }),
    ),
  }
}

/** What the Review screen shows as it opens, or as the scope changes under it: the scope's project and its run going. */
export const opened = (model: Model): Return =>
  step(model, review =>
    Review.opened(review, {
      project: model.scope,
      run: Option.map(model.runView, view => view.header.run),
    }),
  )

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotReviewMessage: ({ message }) => foldReview(model, message),
  PressedReviewTab: ({ tab }) => ({
    model: writeReview(model, Review.selectTab(model.screens.review, tab)),
  }),
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'review',
    view: Review.view,
    model: model.screens.review,
    viewInputs: { today: model.today },
    toParentMessage: message => Message.GotReviewMessage({ message }),
  })
