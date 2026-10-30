import { Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { dayOf, sameDay } from '../../clock'
import type { Handlers, SubscriptionServices } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The clock (spec §18.3, H80): the time now in the viewer's zone, and the start of the viewer's day,
// ticking while an engine is connected.

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  Ticked: ({ now }) => ({
    model: modifyFields(model, {
      now: () => Option.some(now),
      today: today =>
        Option.exists(today, day => sameDay(now, day))
          ? today
          : Option.some(dayOf(now)),
    }),
  }),
})

export const subscriptions = ({ ticks }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    clock: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({
          live: RemoteEngines.liveEngines(model).length > 0,
        }),
        dependenciesToStream: ({ live }) =>
          live
            ? Stream.map(ticks, now => Message.Ticked({ now }))
            : Stream.empty,
      },
    ),
  }))
