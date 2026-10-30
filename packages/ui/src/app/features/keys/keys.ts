import { Option, Stream } from 'effect'
import { Subscription } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { Platform } from '@fabrica/contracts'

import * as Attention from '../../../console/attention'
import * as Stats from '../../../console/stats'
import { isLive } from '../../connection'
import { dialog } from '../../dialog'
import type {
  Handlers,
  Return,
  Root,
  SubscriptionServices,
} from '../../feature'
import {
  type KeyCommand,
  type Pressed,
  commandFor,
  commandsFor,
  keyHelp,
  keyHelpOverlayKeys,
  keyLabel,
} from '../../keys'
import { Message } from '../../message'
import { type Model, Overlay } from '../../model'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The keys (spec §18.5): each key pressed runs the command the screen's list binds it to (keys.ts), and
// the key help, drawn from the same list, opens over the screen.

/** Whether the Model's overlay is open. */
export const isOverlayOpen = (model: Model): boolean =>
  !Overlay.guards.Closed(model.overlay)

/** The run controls the stats row offers now, for the scoped project. */
export const runOffers = (model: Model): ReadonlyArray<Stats.Offer> =>
  Stats.offers(model.console.stats, {
    project: model.scope,
    live: isLive(model.connection),
    run: model.runView,
  })

/** The command list of the screen shown, with its overlay's. */
export const modelCommands = (model: Model) =>
  commandsFor({
    screen: model.screen,
    overlayOpen: isOverlayOpen(model),
    paletteOpen: Overlay.guards.Palette(model.overlay),
    options: Attention.keyedOptions(model.console.attention),
    approval: Attention.keyedApproval(model.console.attention),
    offers: runOffers(model),
  })

/** The screen's command list as it stands with no overlay open: what the palette runs and the key help names. */
export const screenCommands = (model: Model) =>
  commandsFor({
    screen: model.screen,
    overlayOpen: false,
    options: Attention.keyedOptions(model.console.attention),
    approval: Attention.keyedApproval(model.console.attention),
    offers: runOffers(model),
  })

/**
 * The key help's list (§18.5): Escape closing it, then the screen's commands as they stand beneath
 * it, so the help names the keys the screen answers once it is closed, the attention column's too.
 */
export const keyHelpCommands = (model: Model): ReadonlyArray<KeyCommand> => [
  ...keyHelpOverlayKeys,
  ...screenCommands(model),
]

export const update = (
  model: Model,
  root: Root,
): Handlers<keyof typeof messages> => ({
  PressedKey: pressed =>
    Option.match(commandFor(modelCommands(model), pressed), {
      onNone: (): Return => ({ model }),
      onSome: command => root.update(model, command.message),
    }),
  RequestedKeyHelp: () => ({
    model: modifyFields(model, { overlay: () => Overlay.KeyHelp() }),
  }),
  DismissedOverlay: () => ({
    model: modifyFields(model, { overlay: () => Overlay.Closed() }),
  }),
})

export const keyCap = (label: string, h: HtmlBuilder<Message>): Html =>
  h.kbd(
    [h.Class('rounded-button border border-line px-4 font-mono text-xs')],
    [label],
  )

/** A hint: the command's control with its key beside it. */
export const hintButton = (
  command: KeyCommand,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    command.id,
    [
      h.Type('button'),
      h.OnClick(command.message),
      h.Class('flex items-center gap-6 text-xs text-muted'),
      ...Option.match(keyLabel(command, platform), {
        onNone: () => [],
        onSome: label => [h.AriaKeyshortcuts(label)],
      }),
    ],
    [
      command.title,
      ...Option.match(keyLabel(command, platform), {
        onNone: () => [],
        onSome: label => [keyCap(label, h)],
      }),
    ],
  )

/** The key help, over the screen: every command of its list with a key. */
export const keyHelpView = (model: Model, h: HtmlBuilder<Message>): Html =>
  dialog(
    'Keys',
    [
      h.h2([h.Class('px-12 text-sm font-extrabold')], ['Keys']),
      h.ul(
        [h.Class('flex flex-col')],
        keyHelp(keyHelpCommands(model)).map(command =>
          h.keyed('li')(
            command.id,
            [h.Class('flex items-center gap-12 px-12 py-4 text-sm')],
            [
              keyCap(
                Option.getOrElse(keyLabel(command, model.platform), () => ''),
                h,
              ),
              h.span([], [command.title]),
            ],
          ),
        ),
      ),
    ],
    h,
  )

/** The keys going down in `target`'s window, each with whether focus was in a text field. */
export const documentKeys = (target: Document): Stream.Stream<Pressed> =>
  Stream.fromEventListener<KeyboardEvent>(target, 'keydown').pipe(
    Stream.map(event => ({
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      inField:
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable),
    })),
  )

export const subscriptions = ({ keys }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(() => ({
    keys: Subscription.persistentEntry(
      Stream.map(keys, pressed => Message.PressedKey(pressed)),
    ),
  }))
