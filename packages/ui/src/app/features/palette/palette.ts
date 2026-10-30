import { Array, Option } from 'effect'
import { Command } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { TicketId, TicketRow } from '@fabrica/contracts'

import * as Sidebar from '../../../console/sidebar'
import * as Palette from '../../../screens/palette'
import { themeTitle, themes } from '../../../theme/theme'
import { dialog } from '../../dialog'
import { projectKey } from '../../engine-project'
import type { Handlers, Return, Root } from '../../feature'
import { keyLabel, paletteCommands, paletteOverlayKeys } from '../../keys'
import { Message } from '../../message'
import { type Model, Overlay } from '../../model'
import { screenCommands } from '../keys/keys'
import { openWorker } from '../screen/screen'
import type { messages } from './message'

// The command palette (spec §18.5): the screen's commands, every project, the scoped run's tickets and
// workers and the themes, searched, and the one chosen run as the palette closes.

/**
 * The palette's entries (§18.5): the screen's own command list as it is with no overlay open, but the
 * palette's own command; then every project, the scoped run's tickets (and the Backlog's, while it
 * shows them) and its workers, each opening its worker view on the scoped project; then the themes.
 */
export const paletteEntries = (
  model: Model,
): ReadonlyArray<Palette.Entry<Message>> => {
  const commands = paletteCommands(screenCommands(model)).map(
    (command): Palette.Entry<Message> => ({
      id: command.id,
      group: 'command',
      title: command.title,
      key: keyLabel(command, model.platform),
      run: command.message,
    }),
  )
  const enginesKnown = model.console.sidebar.engines.length
  const projects: ReadonlyArray<Palette.Entry<Message>> = [
    {
      id: 'project.all',
      group: 'project',
      title: 'All projects',
      key: Option.none(),
      run: Message.SelectedScope({ project: Option.none() }),
    },
    ...Sidebar.rows(model.console.sidebar).map(
      (row): Palette.Entry<Message> => ({
        id: `project.${projectKey(Sidebar.rowProject(row))}`,
        group: 'project',
        title:
          enginesKnown > 1
            ? `${row.status.name} · ${row.engine.name}`
            : row.status.name,
        key: Option.none(),
        run: Message.SelectedScope({
          project: Option.some(Sidebar.rowProject(row)),
        }),
      }),
    ),
  ]
  const runTickets: ReadonlyArray<TicketRow> = Option.match(model.runView, {
    onNone: () => [],
    onSome: run => run.tickets,
  })
  const openScoped = (ticket: TicketId): ReadonlyArray<Message> =>
    Option.match(model.scope, {
      onNone: () => [],
      onSome: project => [openWorker(project, ticket)],
    })
  const known: ReadonlyArray<{
    readonly ticket: TicketId
    readonly title: string
  }> = [
    ...runTickets.map(row => ({ ticket: row.ticket, title: row.title })),
    ...Option.match(model.backlog, {
      onNone: () => [],
      onSome: backlog =>
        backlog.map(ticket => ({ ticket: ticket.id, title: ticket.title })),
    }),
  ]
  const tickets = Array.dedupeWith(
    known,
    (first, second) => first.ticket === second.ticket,
  ).flatMap(({ ticket, title }) =>
    openScoped(ticket).map((run): Palette.Entry<Message> => ({
      id: `ticket.${ticket}`,
      group: 'ticket',
      title: `${ticket} ${title}`,
      key: Option.none(),
      run,
    })),
  )
  const workers = Option.match(model.runView, {
    onNone: () => [],
    onSome: run => run.workers,
  }).flatMap(worker =>
    openScoped(worker.ticket).map((run): Palette.Entry<Message> => ({
      id: `worker.${worker.ticket}`,
      group: 'worker',
      title: Option.match(
        Array.findFirst(runTickets, row => row.ticket === worker.ticket),
        {
          onNone: () => `${worker.ticket} · ${worker.model}`,
          onSome: row => `${worker.ticket} ${row.title} · ${worker.model}`,
        },
      ),
      key: Option.none(),
      run,
    })),
  )
  const themeEntries = themes.map((theme): Palette.Entry<Message> => ({
    id: `theme.${theme}`,
    group: 'theme',
    title: themeTitle(theme),
    key: Option.none(),
    run: Message.ChoseTheme({ theme }),
  }))
  return [...commands, ...projects, ...tickets, ...workers, ...themeEntries]
}

const writePalette = (model: Model, palette: Palette.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { palette: () => palette }),
  })

/**
 * Runs a palette entry where there is one, while the palette is open: it closes, then the entry's
 * Message is sent. An entry asked for once it has closed runs nothing.
 */
const runPaletteEntry = (
  model: Model,
  root: Root,
  entry: Option.Option<Palette.Entry<Message>>,
): Return =>
  Option.match(
    Option.filter(entry, () => Overlay.guards.Palette(model.overlay)),
    {
      onNone: () => ({ model }),
      onSome: ({ run }) =>
        root.update(
          modifyFields(model, { overlay: () => Overlay.Closed() }),
          run,
        ),
    },
  )

export const update = (
  model: Model,
  root: Root,
): Handlers<keyof typeof messages> => ({
  RequestedPalette: () => ({
    model: writePalette(
      modifyFields(model, { overlay: () => Overlay.Palette() }),
      Palette.init(),
    ),
  }),
  GotPaletteMessage: ({ message }) => ({
    model: writePalette(model, Palette.update(model.screens.palette, message)),
  }),
  MovedPaletteSelection: ({ by }) => {
    const entries = paletteEntries(model)
    const palette = Palette.moved(
      model.screens.palette,
      by,
      Palette.matching(entries, model.screens.palette.query).length,
    )
    // The list scrolls to keep the selection in view.
    return {
      model: writePalette(model, palette),
      commands: Option.match(Palette.selected(palette, entries), {
        onNone: () => [],
        onSome: ({ id }) => [
          Command.mapMessage(Palette.ScrollToEntry({ id }), message =>
            Message.GotPaletteMessage({ message }),
          ),
        ],
      }),
    }
  },
  RanPaletteSelection: () =>
    runPaletteEntry(
      model,
      root,
      Palette.selected(model.screens.palette, paletteEntries(model)),
    ),
  RanPaletteEntry: ({ id }) =>
    runPaletteEntry(
      model,
      root,
      Array.findFirst(paletteEntries(model), entry => entry.id === id),
    ),
})

const toPaletteMessage = (message: Palette.Message): Message =>
  Message.GotPaletteMessage({ message })

const runEntry = (id: string): Message => Message.RanPaletteEntry({ id })

/** The palette, over the screen. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  dialog(
    'Command palette',
    [
      Palette.view(
        model.screens.palette,
        {
          entries: paletteEntries(model),
          keys: paletteOverlayKeys.flatMap(command =>
            Option.match(keyLabel(command, model.platform), {
              onNone: () => [],
              onSome: key => [{ id: command.id, title: command.title, key }],
            }),
          ),
          toParentMessage: toPaletteMessage,
          run: runEntry,
        },
        h,
      ),
    ],
    h,
  )
