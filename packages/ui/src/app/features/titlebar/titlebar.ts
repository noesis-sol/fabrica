import { Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import type { HostLoad, UsageWindow } from '@fabrica/contracts'

import * as Titlebar from '../../../console/titlebar'
import { EngineProject } from '../../engine-project'
import { scopeEngine, withEngineClient } from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { keyLabel, openPalette } from '../../keys'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import { applyLoad, applyUsage, watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The title bar (spec §18.3): the window's controls, the search field that opens the palette, and the
// scoped project's engine's host's load and its account's usage windows.

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ReceivedLoad: ({ engine, items }) => ({
    model:
      engine === scopeEngine(model.scope)
        ? modifyFields(model, { load: load => applyLoad(load, items) })
        : model,
  }),
  ReceivedUsage: ({ project, items }) => ({
    model: Option.contains(model.scope, project)
      ? modifyFields(model, { usage: usage => applyUsage(usage, items) })
      : model,
  }),
})

/** Whether the scoped run holds on a usage limit: its banner then takes the usage windows' place (§18.3). */
const usageHeld = (model: Model): boolean =>
  Option.exists(model.runView, runView =>
    runView.holds.some(hold => hold.kind === 'USAGE_LIMIT'),
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  Titlebar.view(
    model.console.titlebar,
    {
      platform: model.platform,
      load: model.load,
      usage: model.usage,
      usageHeld: usageHeld(model),
      search: {
        hint: Option.getOrElse(keyLabel(openPalette, model.platform), () => ''),
        open: openPalette.message,
      },
    },
    h,
  )

/** The host's load of the engine named `engine`. */
export const loadMessages = (
  client: EngineClientShape,
  engine: string,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<HostLoad, HostLoad>(client)(resume =>
    client.rpc['engine.watchLoad']({ resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedLoad({ engine, items })),
    Stream.catch(() => Stream.empty),
  )

/** The usage windows of the project's provider account. */
export const usageMessages = (
  client: EngineClientShape,
  project: EngineProject,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<UsageWindow>, UsageWindow>(client)(resume =>
    client.rpc['projects.watchUsage']({ project: project.project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedUsage({ project, items })),
    Stream.catch(() => Stream.empty),
  )

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    // The stats row's load: the scoped project's engine's host's.
    load: entry(
      { engine: Schema.String, live: Schema.Boolean },
      {
        modelToDependencies: model => {
          const engine = scopeEngine(model.scope)
          return { engine, live: RemoteEngines.isEngineLive(model, engine) }
        },
        dependenciesToStream: ({ engine, live }) =>
          live
            ? withEngineClient(engine, client =>
                loadMessages(client, engine, nextFrame),
              )
            : Stream.empty,
      },
    ),
    // The title bar's usage windows: the scoped project's provider account's, through its engine.
    usage: entry(
      { project: Schema.Option(EngineProject) },
      {
        modelToDependencies: model => ({
          project: RemoteEngines.liveScope(model),
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withEngineClient(project.engine, client =>
                usageMessages(client, project, nextFrame),
              ),
          }),
      },
    ),
  }))
