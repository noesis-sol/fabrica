import { Data, Option } from 'effect'

import type { LabelName, Ticket } from '@fabrica/contracts'

import type { Declared } from './declared'
import { nfc } from './glob'
import { isDocument, repoPath, sorted } from './names'
import { Place, type Repository, placeName } from './repository'
import {
  asksChange,
  eachPathWord,
  functionsIn,
  isTypeMethod,
  sentences,
} from './text'

// A ticket's footprint (spec §13.4, H70): its `files`, its area labels and, while it runs, the files
// its worktree changed. Only a ticket that gives no `files` has its title, description, design and
// acceptance (never its notes, which say what happened to it) read for paths and functions, or,
// where its text names none, the predictor's guess (`predicted_files`, §16). A path in its text is a
// tracked file's path, or a tracked file's bare name capitalised or quoted (`Makefile`); a function
// counts only where the repository declares it (`Declared`). tutti read every path a ticket's text
// named as one it would change, so a ticket naming the check script in its acceptance held every
// other behind it.

/** The label prefix of an area: tickets sharing an `area:<name>` label overlap. */
export const areaPrefix = 'area:'

/** Where a footprint's files came from. */
export type FootprintSource = Data.TaggedEnum<{
  /** The ticket's `files`. */
  Files: {}
  /** Its text, as it gives no `files`. */
  Text: {}
  /** The predictor's guess, as its text names nothing. */
  Predicted: {}
  /** What its branch changed: a ticket past its work holds on those alone. */
  Branch: {}
  /** Nothing named: its areas and changes alone. */
  Nothing: {}
}>
export const FootprintSource = Data.taggedEnum<FootprintSource>()

/** Where a ticket works. */
export interface Footprint {
  readonly source: FootprintSource
  /** The places it is to change. */
  readonly places: ReadonlyArray<Place>
  /**
   * The tracked documents its text names only to read (`per CLAUDE.md`, the spec its `spec`
   * metadata cites), with no sentence asking to change them: they hold no ticket apart that
   * doesn't change them. Sorted.
   */
  readonly cited: ReadonlyArray<string>
  /** The functions its text names that the repository declares (`Loop.merge`, `waitSettled`), sorted. */
  readonly functions: ReadonlyArray<string>
  /** The functions its text names that the repository doesn't declare (`JSON.stringify`): shown, holding nothing. */
  readonly undeclared: ReadonlyArray<string>
  /** Its `area:` labels, sorted. */
  readonly areas: ReadonlyArray<string>
  /** The files its worktree changed, sorted. */
  readonly changed: ReadonlyArray<string>
}

/** What a footprint is read from: a ticket's fields, and its labels. */
export interface FootprintTicket {
  readonly ticket: Pick<
    Ticket,
    'title' | 'description' | 'design' | 'acceptance' | 'metadata'
  >
  readonly labels: ReadonlyArray<LabelName>
}

const areasOf = (labels: ReadonlyArray<LabelName>): ReadonlyArray<string> =>
  sorted(
    labels.filter(
      label => label.startsWith(areaPrefix) && label.length > areaPrefix.length,
    ),
  )

/** The places a list of `files` entries names, each once. */
const placesOf = (
  entries: ReadonlyArray<string>,
  repository: Repository,
): ReadonlyArray<Place> => {
  const byName = new Map<string, Place>()
  for (const entry of entries)
    for (const place of repository.place(entry))
      byName.set(placeName(place), place)
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, place]) => place)
}

/** What a ticket's text names: the files it changes and cites, and its candidate functions. */
const readText = (
  text: string,
  spec: ReadonlyArray<string>,
  repository: Repository,
): {
  readonly changes: ReadonlyArray<string>
  readonly cited: ReadonlyArray<string>
  readonly functions: ReadonlyArray<string>
} => {
  const changes = new Set<string>()
  const cited = new Set<string>()
  const functions = new Set<string>(functionsIn(text))
  for (const sentence of sentences(text)) {
    // A path holds no space, so each is within one word.
    const words = sentence.split(/\s+/u).filter(word => word !== '')
    words.forEach((word, i) =>
      eachPathWord(word, ({ word: token, quoted }) => {
        const files = repository.named(token, quoted)
        for (const file of files)
          if (
            isDocument(file) &&
            (spec.includes(file) || !asksChange(words, i))
          )
            cited.add(file)
          else changes.add(file)
        if (files.length > 0) return true
        if (!isTypeMethod(token)) return false
        functions.add(token)
        return true
      }),
    )
  }
  return {
    changes: sorted(changes),
    cited: sorted([...cited].filter(file => !changes.has(file))),
    functions: sorted(functions),
  }
}

const textOf = (ticket: FootprintTicket['ticket']): string =>
  [
    ticket.title,
    ...[ticket.description, ticket.design, ticket.acceptance].flatMap(field =>
      Option.toArray(field),
    ),
  ].join('\n')

/** The tracked files the ticket's `spec` metadata names: cited, unless a sentence asks to change them. */
const specOf = (
  ticket: FootprintTicket['ticket'],
  repository: Repository,
): ReadonlyArray<string> =>
  Option.match(ticket.metadata.spec, {
    onNone: () => [],
    onSome: spec =>
      Option.toArray(Option.fromNullishOr(repository.tracked(spec))),
  })

const empty = {
  places: [],
  cited: [],
  functions: [],
  undeclared: [],
  changed: [],
} as const

/**
 * Whether the ticket's footprint is read from its text and that text names a function, which only
 * the repository's declarations (`readDeclared`) tell from a library's.
 */
export const namesFunctions = (input: {
  readonly ticket: FootprintTicket
  readonly repository: Repository
}): boolean => {
  const { ticket } = input.ticket
  return (
    Option.getOrElse(ticket.metadata.files, () => []).length === 0 &&
    readText(textOf(ticket), specOf(ticket, input.repository), input.repository)
      .functions.length > 0
  )
}

/**
 * Where a ticket works, before it runs: its `files` where it gives any; else what its text names,
 * the functions among them only where `declared` says the repository declares them; else its
 * `predicted_files`. Its area labels in each case.
 */
export const ticketFootprint = (input: {
  readonly ticket: FootprintTicket
  readonly repository: Repository
  readonly declared: Declared
}): Footprint => {
  const { ticket, labels } = input.ticket
  const areas = areasOf(labels)
  const files = Option.getOrElse(ticket.metadata.files, () => [])
  if (files.length > 0)
    return {
      ...empty,
      source: FootprintSource.Files(),
      places: placesOf(files, input.repository),
      areas,
    }
  const text = readText(
    textOf(ticket),
    specOf(ticket, input.repository),
    input.repository,
  )
  const functions = text.functions.filter(fn => input.declared.declares(fn))
  const undeclared = text.functions.filter(fn => !input.declared.declares(fn))
  if (text.changes.length + text.cited.length + functions.length > 0)
    return {
      ...empty,
      source: FootprintSource.Text(),
      places: text.changes.map(path => Place.File({ path })),
      cited: text.cited,
      functions,
      undeclared,
      areas,
    }
  const predicted = Option.getOrElse(ticket.metadata.predicted_files, () => [])
  if (predicted.length > 0)
    return {
      ...empty,
      source: FootprintSource.Predicted(),
      places: placesOf(predicted, input.repository),
      undeclared,
      areas,
    }
  return { ...empty, source: FootprintSource.Nothing(), undeclared, areas }
}

/** The changed files as footprints name them: as git tracks them, else cleaned and in NFC. */
const changedFiles = (
  changed: ReadonlyArray<string>,
  repository: Repository,
): ReadonlyArray<string> =>
  sorted(
    changed.flatMap(path => {
      const clean = repoPath(nfc(path))
      return clean === undefined ? [] : [repository.tracked(clean) ?? clean]
    }),
  )

/** The footprint grown by the files the ticket's worktree changed while it runs. */
export const withChanges = (input: {
  readonly footprint: Footprint
  readonly changed: ReadonlyArray<string>
  readonly repository: Repository
}): Footprint => ({
  ...input.footprint,
  changed: sorted([
    ...input.footprint.changed,
    ...changedFiles(input.changed, input.repository),
  ]),
})

/**
 * The footprint of a ticket past its work (waiting to merge, merging, resolving, fixing): the files
 * its branch changed and its area labels, not what its `files` or text named. Once the work is done,
 * the branch is the truth.
 */
export const branchFootprint = (input: {
  readonly labels: ReadonlyArray<LabelName>
  readonly changed: ReadonlyArray<string>
  readonly repository: Repository
}): Footprint => ({
  ...empty,
  source: FootprintSource.Branch(),
  areas: areasOf(input.labels),
  changed: changedFiles(input.changed, input.repository),
})

/**
 * The footprint as the log's footprint line names it (`footprintLine`): functions, files, globs,
 * then areas; a predicted or branch footprint says so.
 */
export const footprintParts = (footprint: Footprint): ReadonlyArray<string> => {
  const globs = footprint.places.filter(Place.$is('Glob'))
  const others = footprint.places.filter(place => !Place.$is('Glob')(place))
  const parts = [
    ...sorted([...footprint.functions, ...footprint.undeclared]),
    ...sorted([
      ...others.map(placeName),
      ...footprint.cited,
      ...footprint.changed,
    ]),
    ...globs.map(placeName),
    ...footprint.areas,
  ]
  return FootprintSource.$match(footprint.source, {
    Files: () => parts,
    Text: () => parts,
    Predicted: () => [...parts, '(predicted)'],
    Branch: () => [...parts, '(from its branch)'],
    Nothing: () => (parts.length === 0 ? ['nothing named'] : parts),
  })
}
