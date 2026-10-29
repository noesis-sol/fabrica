import { Array, Option } from 'effect'

import type { Platform } from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as Review from '../screens/review'
import { Message } from './message'
import { Screen, screenTitle } from './screen'

// Each screen's keys are one list of commands (spec §18.5), from which its bindings, its hints, the
// key help and the command palette are all drawn, so a bound key can't go missing from the help: tutti
// wrote each screen's keys three times, and they drifted (tutti-rvzn.8). A screen's list is its own
// commands, then the overlay's while one is open, then the commands every screen has.

/** A key, with the platform's command modifier (⌘ on macOS, Ctrl elsewhere) or without. */
export interface Chord {
  readonly key: string
  readonly mod: boolean
  /** A plain key that runs its command while focus is in a text field too, as the palette's arrows do. */
  readonly inField?: boolean
}

/** One command: what it says, its key where it has one, whether the screen hints at it, and what it sends. */
export interface KeyCommand {
  readonly id: string
  readonly title: string
  readonly chord: Option.Option<Chord>
  /** Shown beside the control that does it, as well as in the help and the palette. */
  readonly hint: boolean
  readonly message: Message
}

const plain = (key: string): Option.Option<Chord> =>
  Option.some({ key, mod: false })
const withMod = (key: string): Option.Option<Chord> =>
  Option.some({ key, mod: true })
const fieldKey = (key: string): Option.Option<Chord> =>
  Option.some({ key, mod: false, inField: true })

const goTo = (
  screen: Screen,
  chord: Option.Option<Chord>,
  hint = false,
): KeyCommand => ({
  id: `go.${screen._tag}`,
  title: `Go to ${screenTitle(screen)}`,
  chord,
  hint,
  message: Message.RequestedScreen({ screen }),
})

/** The palette's command, whose key the title bar's search field hints at. */
export const openPalette: KeyCommand = {
  id: 'palette',
  title: 'Open the command palette',
  chord: withMod('k'),
  hint: true,
  message: Message.RequestedPalette(),
}

/** The commands every screen has. */
const everywhere: ReadonlyArray<KeyCommand> = [
  openPalette,
  {
    id: 'help',
    title: 'Show the keys',
    chord: plain('?'),
    hint: false,
    message: Message.RequestedKeyHelp(),
  },
  goTo(Screen.Console(), withMod('1')),
  goTo(Screen.Talks(), withMod('2')),
  goTo(Screen.Backlog(), withMod('3')),
  goTo(Screen.Review(), withMod('4')),
  goTo(Screen.Insights(), withMod('5')),
  goTo(Screen.Engines(), withMod('6')),
  goTo(Screen.Settings(), withMod(',')),
]

const backToConsole: KeyCommand = {
  id: 'back',
  title: 'Back to the console',
  chord: plain('Escape'),
  hint: true,
  message: Message.RequestedScreen({ screen: Screen.Console() }),
}

/** The options keys 1–9 answer, with the request they answer: those of the question whose options are drawn. */
export type KeyedOptions = ReturnType<typeof Attention.keyedOptions>

/** Keys 1–9, each answering the drawn question with the option at its place (§18.3); the column guards them (§15.1). */
const answerKeys = (options: KeyedOptions): ReadonlyArray<KeyCommand> =>
  Option.match(options, {
    onNone: () => [],
    onSome: ({ key, options }) =>
      options.map(shown => ({
        id: `answer.${shown.place + 1}`,
        title: `Answer: ${shown.option.label}`,
        chord: plain(String(shown.place + 1)),
        hint: false,
        message: Message.PressedAnswerKey({ key, place: shown.place }),
      })),
  })

/** The Review screen's views, each a key (§18.4). */
const reviewKeys: ReadonlyArray<KeyCommand> = (
  [
    { tab: 'diff', key: 'd', title: 'Show the diff' },
    { tab: 'report', key: 'r', title: 'Show the report' },
    { tab: 'log', key: 'l', title: 'Show the log' },
  ] satisfies ReadonlyArray<{
    readonly tab: Review.Tab
    readonly key: string
    readonly title: string
  }>
).map(({ tab, key, title }) => ({
  id: `review.${tab}`,
  title,
  chord: plain(key),
  hint: true,
  message: Message.PressedReviewTab({ tab }),
}))

/** Each screen's own commands; the screens' tickets add theirs here. */
const ofScreen = (
  screen: Screen,
  options: KeyedOptions,
): ReadonlyArray<KeyCommand> =>
  Screen.match(screen, {
    Console: () => answerKeys(options),
    Worker: () => [backToConsole],
    Talks: () => [backToConsole],
    Backlog: () => [backToConsole],
    Review: () => [...reviewKeys, backToConsole],
    Insights: () => [backToConsole],
    Engines: () => [backToConsole],
    Settings: () => [backToConsole],
  })

const closeOverlay: KeyCommand = {
  id: 'close',
  title: 'Close',
  chord: plain('Escape'),
  hint: false,
  message: Message.DismissedOverlay(),
}

/** The palette's own keys, answered from its search field: they move through its entries and run one. */
const paletteKeys: ReadonlyArray<KeyCommand> = [
  {
    id: 'palette.next',
    title: 'Next',
    chord: fieldKey('ArrowDown'),
    hint: false,
    message: Message.MovedPaletteSelection({ by: 1 }),
  },
  {
    id: 'palette.previous',
    title: 'Previous',
    chord: fieldKey('ArrowUp'),
    hint: false,
    message: Message.MovedPaletteSelection({ by: -1 }),
  },
  {
    id: 'palette.run',
    title: 'Run',
    chord: fieldKey('Enter'),
    hint: false,
    message: Message.RanPaletteSelection(),
  },
]

/** The keys the open palette answers to, as its foot names them: its own, then Escape's. */
export const paletteOverlayKeys: ReadonlyArray<KeyCommand> = [
  ...paletteKeys,
  closeOverlay,
]

/** The screen's command list: an open overlay's commands first, so its keys win, then the screen's, then everyone's. */
export const commandsFor = (options: {
  readonly screen: Screen
  readonly overlayOpen: boolean
  /** The open overlay is the palette, whose own keys come first. */
  readonly paletteOpen?: boolean
  /** The attention column's drawn options, which keys 1–9 answer while no overlay covers them. */
  readonly options?: KeyedOptions
}): ReadonlyArray<KeyCommand> => [
  ...(options.overlayOpen && options.paletteOpen === true ? paletteKeys : []),
  ...(options.overlayOpen ? [closeOverlay] : []),
  ...ofScreen(
    options.screen,
    options.overlayOpen ? Option.none() : (options.options ?? Option.none()),
  ),
  ...everywhere,
]

/** A key as it went down. */
export interface Pressed {
  readonly key: string
  readonly mod: boolean
  readonly alt: boolean
  /** Focus is in a text field: its plain keys are typing, not commands. */
  readonly inField: boolean
}

const matches = (chord: Chord, pressed: Pressed): boolean =>
  chord.key.toLowerCase() === pressed.key.toLowerCase() &&
  chord.mod === pressed.mod &&
  !pressed.alt &&
  (chord.mod ||
    chord.key === 'Escape' ||
    chord.inField === true ||
    !pressed.inField)

/** The command a key runs: the first in the list whose chord it is. */
export const commandFor = (
  commands: ReadonlyArray<KeyCommand>,
  pressed: Pressed,
): Option.Option<KeyCommand> =>
  Array.findFirst(commands, command =>
    Option.exists(command.chord, chord => matches(chord, pressed)),
  )

/** The named keys, as a key cap writes them. */
const keyNames: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  ArrowDown: '↓',
  ArrowUp: '↑',
  Enter: '⏎',
}

/** A chord as the platform writes it: `⌘K` on macOS, `Ctrl+K` elsewhere. */
export const chordLabel = (chord: Chord, platform: Platform): string => {
  const key =
    keyNames[chord.key] ??
    (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  if (!chord.mod) {
    return key
  }
  return platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`
}

/** A command's key, as the platform writes it, where it has one. */
export const keyLabel = (
  command: KeyCommand,
  platform: Platform,
): Option.Option<string> =>
  Option.map(command.chord, chord => chordLabel(chord, platform))

/** The key help: every command with a key, in the list's order, each key once (the first command bound to it). */
export const keyHelp = (
  commands: ReadonlyArray<KeyCommand>,
): ReadonlyArray<KeyCommand & { readonly chord: Option.Some<Chord> }> =>
  Array.dedupeWith(
    commands.filter(
      (
        command,
      ): command is KeyCommand & { readonly chord: Option.Some<Chord> } =>
        Option.isSome(command.chord),
    ),
    (first, second) =>
      first.chord.value.key.toLowerCase() ===
        second.chord.value.key.toLowerCase() &&
      first.chord.value.mod === second.chord.value.mod,
  )

/** The palette's commands: every command of the list but the palette itself. */
export const paletteCommands = (
  commands: ReadonlyArray<KeyCommand>,
): ReadonlyArray<KeyCommand> =>
  commands.filter(command => command.id !== openPalette.id)

/** The hints: the commands the screen shows beside their controls. */
export const hints = (
  commands: ReadonlyArray<KeyCommand>,
): ReadonlyArray<KeyCommand> => commands.filter(command => command.hint)
