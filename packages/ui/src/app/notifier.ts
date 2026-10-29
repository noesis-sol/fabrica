import { Context, Effect, Layer, Queue, Stream } from 'effect'
import { Command } from 'foldkit'

import { Message } from './message'
import {
  DesktopNotification,
  type NotificationTarget,
  type NotificationsApi,
} from './notify'

// The renderer's end of the app's notifications (spec §18.5): a service the program is given, which
// shows a notification through the preload and hands back the targets of those clicked. The renderer
// alone in a browser has no preload, and shows none.

export interface NotifierShape {
  readonly notify: (notification: DesktopNotification) => Effect.Effect<void>
  /** The target of each notification clicked. */
  readonly clicks: Stream.Stream<NotificationTarget>
}

export class Notifier extends Context.Service<Notifier, NotifierShape>()(
  '@fabrica/ui/Notifier',
) {}

/** The notifier over the preload's notifications. */
export const notifierOf = (api: NotificationsApi): NotifierShape => ({
  notify: notification => Effect.sync(() => api.notify(notification)),
  clicks: Stream.callback<NotificationTarget>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        api.onClick(target => Queue.offerUnsafe(queue, target)),
      ),
      stop => Effect.sync(stop),
    ),
  ),
})

/** A notifier that shows nothing: the renderer without the app around it. */
export const silentNotifier: NotifierShape = {
  notify: () => Effect.void,
  clicks: Stream.never,
}

export const layerNotifier = (notifier: NotifierShape): Layer.Layer<Notifier> =>
  Layer.succeed(Notifier, Notifier.of(notifier))

/** Shows a notification. */
export const ShowNotification = Command.define('ShowNotification', {
  args: { notification: DesktopNotification },
  messages: [Message.CompletedShowNotification],
  execute: ({ notification }) =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.notify(notification)
      return Message.CompletedShowNotification()
    }),
})
