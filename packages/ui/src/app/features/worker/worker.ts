import { Array, Option, Predicate, Schema, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import type { TranscriptEntry } from '@fabrica/contracts'

import * as Worker from '../../../screens/worker'
import { sameProject } from '../../engine-project'
import { type EngineServices, withEngineClient } from '../../engine-route'
import type { Handlers, Return, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import { Screen } from '../../screen'
import { watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The Worker view (spec §18.4): a worker's ticket, its live figures, its transcript and its composer.
// Only the worker shown has its transcript watched: an inactive worker costs nothing (§18.5).

/** The Worker view's own Model changed, and its Commands lifted, by `step`. */
const step = (
  model: Model,
  stepWorker: (
    worker: Worker.Model,
  ) => Update.Return<Worker.Model, Worker.Message, EngineServices>,
): Return => {
  const stepped = stepWorker(model.screens.worker)
  return {
    model: modifyFields(model, {
      screens: screens =>
        modifyFields(screens, { worker: () => stepped.model }),
    }),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotWorkerMessage({ message }),
    ),
  }
}

/** The worker view of `worker` reads its ticket, as it opens or as its engine is reached again. */
export const opened = (model: Model, worker: Worker.Shown): Return =>
  step(model, shown => Worker.opened(shown, worker))

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotWorkerMessage: ({ message }) =>
    step(model, worker => Worker.update(worker, message)),
  PressedWorkerKey: ({ key }) =>
    step(model, worker => Worker.pressedKey(worker, key)),
  ReceivedWorkerTranscript: ({ worker, items }) =>
    step(model, shown => Worker.receivedTranscript(shown, worker, items)),
  EndedWorkerTranscript: ({ worker }) =>
    step(model, shown => Worker.endedTranscript(shown, worker)),
  FailedWorkerTranscript: ({ worker, reason }) =>
    step(model, shown => Worker.failedTranscript(shown, worker, reason)),
})

/**
 * What the worker view draws beside its own Model: its engine's connection, the clock, its row in its
 * project's run view and the run's spending, the scoped project's or under All projects its own, and,
 * where its project is the scope's, the usage windows.
 */
const workerInputs = (
  model: Model,
  worker: Worker.Shown,
): Worker.ViewInputs => {
  const scoped = Option.exists(model.scope, scope =>
    sameProject(scope, worker.project),
  )
  const run = scoped
    ? model.runView
    : Option.isNone(model.scope)
      ? Option.map(
          Array.findFirst(model.runViews, entry =>
            sameProject(entry.project, worker.project),
          ),
          ({ view }) => view,
        )
      : Option.none()
  return {
    live: RemoteEngines.isEngineLive(model, worker.project.engine),
    now: model.now,
    row: Option.flatMap(run, view =>
      Array.findFirst(view.workers, row => row.ticket === worker.ticket),
    ),
    usage: scoped ? model.usage : Option.none(),
    runTokens: Option.map(run, view => view.totals.tokens),
  }
}

export const view = (
  model: Model,
  worker: Worker.Shown,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'worker',
    view: Worker.view,
    model: model.screens.worker,
    viewInputs: workerInputs(model, worker),
    toParentMessage: message => Message.GotWorkerMessage({ message }),
  })

/** The tag of an error that ended a stream, as its reason. */
const reasonOf = (error: { readonly _tag: string }): string => error._tag

/**
 * The worker's transcript, a frame's entries at a time; its end, when the worker has finished (its
 * watch ends, or the engine no longer has it), or why it couldn't be read.
 */
export const workerTranscriptMessages = (
  client: EngineClientShape,
  worker: Worker.Shown,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<TranscriptEntry>, ReadonlyArray<TranscriptEntry>>(
    client,
  )(resume =>
    client.rpc['worker.watchTranscript']({
      project: worker.project.project,
      ticket: worker.ticket,
      resume,
    }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedWorkerTranscript({ worker, items })),
    Stream.concat(Stream.make(Message.EndedWorkerTranscript({ worker }))),
    Stream.catch(error =>
      Stream.make(
        Predicate.isTagged(error, 'WorkerNotFound')
          ? Message.EndedWorkerTranscript({ worker })
          : Message.FailedWorkerTranscript({
              worker,
              reason: reasonOf(error),
            }),
      ),
    ),
  )

/** The worker whose view is shown, where one is, and whether its engine is connected. */
const shownWorker = (
  model: Model,
): { readonly worker: Option.Option<Worker.Shown>; readonly live: boolean } =>
  Screen.guards.Worker(model.screen)
    ? {
        worker: Option.some({
          project: model.screen.project,
          ticket: model.screen.ticket,
        }),
        live: RemoteEngines.isEngineLive(model, model.screen.project.engine),
      }
    : { worker: Option.none(), live: false }

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    workerTranscript: entry(
      { worker: Schema.Option(Worker.Shown), live: Schema.Boolean },
      {
        modelToDependencies: shownWorker,
        dependenciesToStream: ({ worker, live }) =>
          Option.match(worker, {
            onNone: () => Stream.empty,
            onSome: shown =>
              live
                ? withEngineClient(shown.project.engine, client =>
                    workerTranscriptMessages(client, shown, nextFrame),
                  )
                : Stream.empty,
          }),
      },
    ),
  }))
