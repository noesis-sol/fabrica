import { Array, Effect, Option, Schema } from 'effect'
import { Command, Dom } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

// The command palette (spec §18.5, §18.3's title bar): ⌘K opens it over any screen, listing the
// screen's commands, drawn from its one command list with each one's key, then navigation (the
// projects, the run's tickets and its workers) and the themes. Keyboard first: focus starts in its
// search field, typing filters the list, the arrow keys move the selection and Enter runs it; those
// keys are the palette's own commands in the same list (keys.ts), so the foot that names them is
// drawn from it too.

export const Model = Schema.Struct({
  /** What the search field holds. */
  query: Schema.String,
  /**
   * The selected entry's ID, so the selection stays on its entry as others leave or join the list
   * around it; none while nothing was selected. An ID no longer among the entries selects nothing.
   */
  selected: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ query: '', selected: Option.none() })

export const Message = defineMessageUnion({
  ChangedQuery: { query: Schema.String },
  CompletedScrollToEntry: {},
})
export type Message = typeof Message.Type

/** What an entry does: one of the screen's commands, or a way to a project, a ticket, a worker or a theme. */
export type Group = 'command' | 'project' | 'ticket' | 'worker' | 'theme'

/** A group's name, beside each of its entries but the commands, which have their keys there. */
const groupTitle = (group: Group): Option.Option<string> =>
  group === 'command'
    ? Option.none()
    : Option.some(
        {
          project: 'Project',
          ticket: 'Ticket',
          worker: 'Worker',
          theme: 'Theme',
        }[group],
      )

/** One of the palette's entries. */
export interface Entry<Message> {
  readonly id: string
  readonly group: Group
  readonly title: string
  /** Its key, as the platform writes it, where it has one. */
  readonly key: Option.Option<string>
  readonly run: Message
}

/** What a query is matched against: the entry's title and its group's name. */
const searched = <M>(entry: Entry<M>): string =>
  Option.match(groupTitle(entry.group), {
    onNone: () => entry.title,
    onSome: group => `${entry.title} ${group}`,
  }).toLowerCase()

/** The entries `query` matches, in their order: those holding each of its words, case aside. */
export const matching = <M>(
  entries: ReadonlyArray<Entry<M>>,
  query: string,
): ReadonlyArray<Entry<M>> => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  return entries.filter(entry => {
    const text = searched(entry)
    return words.every(word => text.includes(word))
  })
}

/** The palette on `query`, with the first of `entries` it matches selected. */
const reading = <M>(
  query: string,
  entries: ReadonlyArray<Entry<M>>,
): Model => ({
  query,
  selected: Option.map(Array.head(matching(entries, query)), ({ id }) => id),
})

/** The palette as it opens, on `entries`: no query, the first entry selected. */
export const opened = <M>(entries: ReadonlyArray<Entry<M>>): Model =>
  reading('', entries)

/** A changed query selects the first of `entries` it matches. */
export const update = <M>(
  model: Model,
  message: Message,
  entries: ReadonlyArray<Entry<M>>,
): Model =>
  Message.match(message, {
    ChangedQuery: ({ query }) =>
      query === model.query ? model : reading(query, entries),
    CompletedScrollToEntry: () => model,
  })

/**
 * The selection moved `by` places through the entries the query matches, round from either end. With
 * nothing selected, its entry gone, down starts at the first and up at the last.
 */
export const moved = <M>(
  model: Model,
  by: number,
  entries: ReadonlyArray<Entry<M>>,
): Model => {
  const shown = matching(entries, model.query)
  const place = Option.getOrElse(
    Option.flatMap(model.selected, id =>
      Array.findFirstIndex(shown, entry => entry.id === id),
    ),
    () => (by > 0 ? -1 : 0),
  )
  const count = shown.length
  return count === 0
    ? model
    : {
        ...model,
        selected: Option.map(
          Array.get(shown, (((place + by) % count) + count) % count),
          ({ id }) => id,
        ),
      }
}

/**
 * The selected entry, where the query still matches it. Nothing stands in for an entry gone: Enter
 * runs what is highlighted, never what moved into its place.
 */
export const selected = <M>(
  model: Model,
  entries: ReadonlyArray<Entry<M>>,
): Option.Option<Entry<M>> =>
  Option.flatMap(model.selected, id =>
    Array.findFirst(matching(entries, model.query), entry => entry.id === id),
  )

/** A key the palette answers to, as its foot names it. */
export interface FootKey {
  readonly id: string
  readonly title: string
  readonly key: string
}

export interface ViewInputs<ParentMessage> {
  readonly entries: ReadonlyArray<Entry<ParentMessage>>
  /** The palette's own keys, from the command list. */
  readonly keys: ReadonlyArray<FootKey>
  readonly toParentMessage: (message: Message) => ParentMessage
  /** Runs the entry `id`: a click on it. */
  readonly run: (id: string) => ParentMessage
}

const keyCap = <M>(label: string, h: HtmlBuilder<M>): Html =>
  h.kbd(
    [h.Class('rounded-button border border-line px-4 font-mono text-xs')],
    [label],
  )

const listId = 'palette-entries'

const entryId = (id: string): string => `palette-entry-${id}`

/** Scrolls the list to the entry `id`, where the arrows moved the selection: an entry gone keeps it still. */
export const ScrollToEntry = Command.define('ScrollToEntry', {
  args: { id: Schema.String },
  messages: [Message.CompletedScrollToEntry],
  execute: ({ id }) =>
    Dom.scrollIntoView(`#${CSS.escape(entryId(id))}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollToEntry()),
    ),
})

export const view = <ParentMessage>(
  model: Model,
  inputs: ViewInputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const shown = matching(inputs.entries, model.query)
  const current = selected(model, inputs.entries)
  return h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.div(
        [h.Class('px-12')],
        [
          h.input([
            h.Type('text'),
            h.AriaLabel('Search commands'),
            h.Placeholder('Type a command, a project, a ticket or a theme'),
            h.Autofocus(true),
            h.AriaControls(listId),
            ...Option.match(current, {
              onNone: () => [],
              onSome: entry => [h.AriaActiveDescendant(entryId(entry.id))],
            }),
            h.Value(model.query),
            h.OnInput(query =>
              inputs.toParentMessage(Message.ChangedQuery({ query })),
            ),
            h.Class(
              'w-full rounded-button border border-line bg-bg px-8 py-6 text-sm',
            ),
          ]),
        ],
      ),
      shown.length === 0
        ? h.p(
            [h.Role('status'), h.Class('px-12 py-6 text-sm text-muted')],
            ['Nothing matches.'],
          )
        : h.ul(
            [
              h.Id(listId),
              h.AriaLabel('Commands'),
              h.Class('flex flex-col overflow-auto'),
              h.Style({ maxHeight: '420px' }),
            ],
            shown.map(entry => {
              const isSelected = Option.exists(
                current,
                chosen => chosen.id === entry.id,
              )
              return h.keyed('li')(
                entry.id,
                [],
                [
                  h.button(
                    [
                      h.Id(entryId(entry.id)),
                      h.Type('button'),
                      h.AriaLabel(entry.title),
                      ...Option.match(groupTitle(entry.group), {
                        onNone: () => [],
                        onSome: group => [h.AriaDescription(group)],
                      }),
                      ...Option.match(entry.key, {
                        onNone: () => [],
                        onSome: key => [h.AriaKeyshortcuts(key)],
                      }),
                      h.AriaCurrent(isSelected ? 'true' : 'false'),
                      h.OnClick(inputs.run(entry.id)),
                      h.Class(
                        isSelected
                          ? 'flex w-full items-center gap-8 bg-side px-12 py-6 text-left text-sm font-bold'
                          : 'flex w-full items-center gap-8 px-12 py-6 text-left text-sm',
                      ),
                    ],
                    [
                      h.span(
                        [h.AriaHidden(true), h.Class('w-8 text-c1')],
                        [isSelected ? '›' : ''],
                      ),
                      h.span([h.Class('flex-1 truncate')], [entry.title]),
                      ...Option.match(groupTitle(entry.group), {
                        onNone: () => [],
                        onSome: group => [
                          h.span([h.Class('text-xs text-muted')], [group]),
                        ],
                      }),
                      ...Option.match(entry.key, {
                        onNone: () => [],
                        onSome: key => [keyCap(key, h)],
                      }),
                    ],
                  ),
                ],
              )
            }),
          ),
      h.div(
        [h.Class('flex gap-12 border-t border-line px-12 pt-8')],
        inputs.keys.map(key =>
          h.keyed('span')(
            key.id,
            [h.Class('flex items-center gap-6 text-xs text-muted')],
            [keyCap(key.key, h), key.title],
          ),
        ),
      ),
    ],
  )
}
