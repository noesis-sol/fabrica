import { Option } from 'effect'

import {
  type Note,
  type Ticket,
  type TicketId,
  TicketResult,
} from '@fabrica/contracts'

// A worker's first prompt (spec §13.2, §13.5): the ticket's ID and that its rules are in the system
// prompt, then what the run knows of it: an earlier attempt's notes, the spec's sections it cites,
// and the hand-off results of the tickets it depends on. The ticket's own text is read with
// `get_ticket`, never pasted here.

/** A ticket the worker's ticket depends on, and what it handed off. */
export interface Dependency {
  readonly id: TicketId
  readonly title: string
  readonly result: Option.Option<TicketResult>
}

/** A section of the spec the ticket cites: its number and its text, heading included. */
export interface SpecSection {
  readonly number: string
  readonly text: string
}

/** The spec's sections the ticket cites, read from the spec it is part of. */
export interface CitedSpec {
  readonly path: string
  readonly sections: ReadonlyArray<SpecSection>
}

/** `§13.2`, `§ 13.2`, `§ "13.2 Dispatch"`: a section's number. */
const citation = /§\s*"?(\d+(?:\.\d+)*)/gu

/** The section numbers `texts` cite, each once, in the order first cited. */
export const citedSections = (
  texts: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...new Set(
    texts.flatMap(text =>
      [...text.matchAll(citation)].flatMap(([, number]) =>
        number === undefined ? [] : [number],
      ),
    ),
  ),
]

/** A Markdown heading: its level and the number it starts with, `13.` or `13.2`. */
const heading = /^(#{1,6})\s+(\d+(?:\.\d+)*)\.?(?:\s|$)/u

/** The section numbered `number` in `markdown`, up to the next heading at its level or above. */
export const specSection = (
  markdown: string,
  number: string,
): Option.Option<string> => {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => heading.exec(line)?.[2] === number)
  if (start === -1) return Option.none()
  const level = heading.exec(lines[start] ?? '')?.[1]?.length ?? 1
  const after = lines.slice(start + 1).findIndex(line => {
    const found = /^(#{1,6})\s/u.exec(line)
    return found !== null && (found[1]?.length ?? 7) <= level
  })
  const end = after === -1 ? lines.length : start + 1 + after
  return Option.some(lines.slice(start, end).join('\n').trimEnd())
}

/** The texts of the ticket a citation is read from: never its notes. */
export const citingTexts = (ticket: Ticket): ReadonlyArray<string> => [
  ticket.title,
  ...Option.toArray(ticket.description),
  ...Option.toArray(ticket.design),
  ...Option.toArray(ticket.acceptance),
]

/** A hand-off result in words. */
const resultWords: (result: TicketResult) => string = TicketResult.match({
  summary: ({ summary }) => summary,
  contract_changed: ({ summary, contracts, breaking }) =>
    `${summary} Contracts changed${breaking ? ', breaking' : ''}: ${contracts.join(', ')}.`,
  migration_added: ({ summary, migration }) =>
    `${summary} Migration added: ${migration}.`,
  decision_recorded: ({ summary, decision }) =>
    `${summary} Decision recorded: ${decision}`,
})

/** The first prompt of `ticket`'s worker. */
export const firstPrompt = (input: {
  readonly ticket: TicketId
  readonly notes: ReadonlyArray<Note>
  readonly spec: Option.Option<CitedSpec>
  readonly dependencies: ReadonlyArray<Dependency>
}): string => {
  const parts: Array<string> = [
    `Your ticket is ${input.ticket}. Your standing rules for it are in your system prompt: read the ticket with get_ticket, and end your work through finish, defer, wait_for or ask_question.`,
  ]
  if (input.notes.length > 0)
    parts.push(
      [
        'Notes on it from an earlier attempt, oldest first:',
        ...input.notes.map(note => `- ${note.body}`),
      ].join('\n'),
    )
  Option.match(
    Option.filter(input.spec, ({ sections }) => sections.length > 0),
    {
      onNone: () => undefined,
      onSome: ({ path, sections }) =>
        parts.push(
          [
            `The sections of ${path} it cites:`,
            ...sections.map(section => section.text),
          ].join('\n\n'),
        ),
    },
  )
  if (input.dependencies.length > 0)
    parts.push(
      [
        'What the tickets it depends on handed off:',
        ...input.dependencies.map(dependency =>
          Option.match(dependency.result, {
            onNone: () =>
              `- ${dependency.id} (${dependency.title}): no result recorded.`,
            onSome: result =>
              `- ${dependency.id} (${dependency.title}): ${resultWords(result)}`,
          }),
        ),
      ].join('\n'),
    )
  return parts.join('\n\n')
}
