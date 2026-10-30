import { Option } from 'effect'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as Engines from '../../../screens/engines'
import { Connection } from '../../connection'
import type { Handlers, Return } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as RemoteEngines from '../../remote-engines'
import type { messages } from './message'

// The Engines and projects screen (spec §9, §10.1): this machine's engine and each known engine, their
// projects and credentials, and adding an engine or a project.

/** The Engines screen's own Model changed, and its Commands lifted, by `step`. */
export const step = (
  model: Model,
  stepEngines: (
    engines: Engines.Model,
  ) => Update.Return<Engines.Model, Engines.Message, Engines.Requires>,
): Return => {
  const stepped = stepEngines(model.screens.engines)
  return {
    model: modifyFields(model, {
      screens: screens =>
        modifyFields(screens, { engines: () => stepped.model }),
    }),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotEnginesMessage({ message }),
    ),
  }
}

/** The Engines screen asks again for each engine's status and credentials: this machine's and each connected known engine's. */
export const opened = (model: Model): Return =>
  step(model, engines =>
    Engines.opened(engines, Engines.shownEngines(model.remotes)),
  )

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotEnginesMessage: ({ message }) => {
    const remote = Engines.remoteAfter(model.screens.engines, message)
    const wsl = Engines.reachedInWslAfter(message)
    const folded = step(model, engines =>
      Engines.update(engines, message, model.remotes.engines),
    )
    // The app's engine installed or updated, or found up to date in WSL2: a connection it refused, or
    // one stopped at a refusal (the WSL2 distribution had no fabrica), is tried again.
    const reconnected =
      Engines.reconnectsAfter(message) &&
      (Connection.guards.Refused(folded.model.connection) ||
        Connection.guards.Stopped(folded.model.connection))
        ? modifyFields(folded.model, {
            attempt: attempt => attempt + 1,
            connection: () => Connection.Connecting(),
          })
        : folded.model
    // The engine main reaches in WSL2 then is kept at the app's connection's next hello.
    const local = Option.match(wsl, {
      onNone: () => reconnected,
      onSome: distro =>
        modifyFields(reconnected, {
          remotes: remotes => RemoteEngines.reachedInWsl(remotes, distro),
        }),
    })
    // An engine installed on another host, or paired over TLS, joins the known engines; one tried again
    // is connected to.
    return {
      ...folded,
      model: Option.match(remote, {
        onNone: () => local,
        onSome: change =>
          modifyFields(local, {
            remotes: remotes =>
              Engines.RemoteChange.$match(change, {
                Added: ({ name, address }) =>
                  RemoteEngines.added(remotes, { name, address }),
                Retried: ({ name }) => RemoteEngines.reconnected(remotes, name),
              }),
          }),
      }),
    }
  },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'engines',
    view: Engines.view,
    model: model.screens.engines,
    viewInputs: {
      connection: model.connection,
      engines: model.console.sidebar.engines,
      platform: model.platform,
      remotes: model.remotes,
    },
    toParentMessage: message => Message.GotEnginesMessage({ message }),
  })
