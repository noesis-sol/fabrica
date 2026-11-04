import { Cause, Effect, FiberSet, Option, Ref, Schema } from 'effect'

import type { Actor, OrganName, Ticket, TicketId } from '@fabrica/contracts'

import {
  type Footprint,
  FootprintSource,
  Place,
  type Repository,
  makeRepository,
  ticketText,
} from '../footprints'
import { basename, dirname, isDocument } from '../footprints/names'
import { Git, ticketBranch } from '../git'
import { WorkGraph } from '../workgraph'
import { OrganOutcome, type OrganRuntime } from './runtime'

// The predictor (spec §16, §13.4): a ready ticket whose text names no files has no footprint to hold it
// apart from another, so with more than one slot free a model is given the ticket and the repository's
// files (tests left out unless the ticket mentions tests) and says which it will likely change, kept on
// the ticket as `predicted_files`, which its footprint reads from then on. The ticket waits for the guess
// in the queue, while the slots go to the others. A ticket with commits on its branch is skipped:
// its footprint is what its branch changes (tutti-sp8). Each ticket is asked about once in a run: a guess
// lost is that ticket's alone, logged, and it goes on without one (tutti-mwd). A ticket whose question
// ended waits until the run has read the ready tickets since, so that no look weighs it as it was before.

const organ: OrganName = 'predictor'

/** The organ's answer. */
export const PredictorAnswer = Schema.Struct({
  files: Schema.Array(Schema.String),
})
export type PredictorAnswer = typeof PredictorAnswer.Type

const instructions =
  "You predict the files a ticket's work will change, so that tickets changing the same file don't run side by side. You read no code: you go by the ticket and the repository's file list. Name each file the work will likely change, by its path in the list, or by the path it would have where the work adds it. Leave out the files it would only read. Name files, never folders or globs. Where you can't tell, name fewer."

const description =
  'Gives the files the ticket will likely change, as paths from the repository root.'

/** The file list's share of a question, in characters: some 50,000 tokens, whatever the repository's size. */
const listBudget = 200_000

const testFolders = new Set([
  'test',
  'tests',
  '__tests__',
  '__snapshots__',
  'testdata',
  'fixtures',
])

/** Folders of tests only at the repository's root: `src/spec/` is a program's own. */
const rootTestFolders = new Set(['spec', 'specs'])

/** Whether a path is a test's, by its folders or its name, in the usual runners' ways; a document is none. */
export const isTestFile = (path: string): boolean => {
  if (isDocument(path)) return false
  const folders = dirname(path).toLowerCase().split('/')
  const base = basename(path)
  return (
    folders.some(folder => testFolders.has(folder)) ||
    rootTestFolders.has(folders[0] ?? '') ||
    /[._-](?:test|tests|spec)\.[^.]+$/iu.test(base) ||
    /^test_/iu.test(base) ||
    /[a-z]Tests?\.[^.]+$/u.test(base)
  )
}

/**
 * Whether a ticket's text mentions tests: a word starting `test`, in a compound word too (`go_test`,
 * `loopTest`), or a runner's name, but no word that only ends in it (`latest`, `contest`). Read too
 * freely, it only lists the tests as well.
 */
export const mentionsTests = (text: string): boolean =>
  /(?<![\p{L}\p{N}])(?:(?:unit|py|vi)?test|jest|rspec|junit|e2e)/iu.test(
    text,
  ) || /\p{Ll}Tests?(?![\p{Ll}])/u.test(text)

/** What the predictor reads of a ticket. */
type PredictedTicket = Pick<
  Ticket,
  'id' | 'title' | 'description' | 'design' | 'acceptance'
>

/** The ticket's own text, field by field, as the model reads it. */
const ticketWords = (ticket: PredictedTicket): string =>
  [
    `Ticket ${ticket.id}: ${ticket.title}`,
    ...Option.toArray(ticket.description).map(text => `Description:\n${text}`),
    ...Option.toArray(ticket.design).map(text => `Design:\n${text}`),
    ...Option.toArray(ticket.acceptance).map(text => `Acceptance:\n${text}`),
  ].join('\n\n')

/** The question's file list: tests left out unless the ticket mentions them, within its budget. */
const listFor = (
  ticket: PredictedTicket,
  repository: Repository,
): { readonly listed: ReadonlyArray<string>; readonly cut: number } => {
  const files = mentionsTests(ticketText(ticket))
    ? repository.files
    : repository.files.filter(file => !isTestFile(file))
  const listed: Array<string> = []
  let left = listBudget
  for (const file of files) {
    left -= file.length + 1
    if (left < 0) break
    listed.push(file)
  }
  return { listed, cut: files.length - listed.length }
}

/** The question about one ticket. */
export const predictorPrompt = (
  ticket: PredictedTicket,
  repository: Repository,
): string => {
  const { listed, cut } = listFor(ticket, repository)
  return [
    ticketWords(ticket),
    `The repository's files:\n${listed.join('\n')}`,
    ...(cut === 0 ? [] : [`(${cut} more files aren't shown.)`]),
  ].join('\n\n')
}

/**
 * The answer as a footprint takes it: the files it names, as git tracks them, or those the ticket would
 * add, each once. A folder or a glob is no guess at a file, and would hold every ticket near it apart.
 */
export const guessedFiles = (
  answer: PredictorAnswer,
  repository: Repository,
): ReadonlyArray<string> => [
  ...new Set(
    answer.files.flatMap(entry =>
      repository.place(entry).flatMap(
        Place.$match({
          File: ({ path }): ReadonlyArray<string> => [path],
          Added: ({ path }): ReadonlyArray<string> => [path],
          Folder: (): ReadonlyArray<string> => [],
          Glob: (): ReadonlyArray<string> => [],
        }),
      ),
    ),
  ),
]

/** A ready ticket as the predictor weighs it. */
export interface PredictorCandidate {
  readonly ticket: Ticket
  readonly footprint: Footprint
  readonly solo: boolean
}

/** Whether a guess could change where a ticket works: it names nothing, has had no guess, and runs beside others. */
export const wantsGuess = ({
  ticket,
  footprint,
  solo,
}: PredictorCandidate): boolean =>
  !solo &&
  FootprintSource.$is('Nothing')(footprint.source) &&
  Option.isNone(ticket.metadata.predicted_files)

export interface Predictor {
  /**
   * Weighs the tickets about to run, with `free` slots free, asking about those a guess is wanted for,
   * as many at a time as slots are free: the backlog isn't asked about before its turn. Answers the
   * tickets not to run yet: asked, now or before and not answered, and those whose turn to be asked is
   * to come.
   */
  readonly offer: (input: {
    readonly ready: ReadonlyArray<PredictorCandidate>
    readonly free: number
  }) => Effect.Effect<ReadonlySet<TicketId>>
  /** Whether a ticket waits for its guess: a ticket to come, which keeps the run. */
  readonly asking: Effect.Effect<boolean>
  /**
   * Runs the read of the ready tickets: those whose question ended before it began wait no more, as
   * it has their guess.
   */
  readonly reading: <A, E, R>(
    read: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

/** The run's predictor, within its scope: its questions end with it. */
export const makePredictor = Effect.fn('Predictor.make')(function* (input: {
  readonly organs: Pick<OrganRuntime, 'ask'>
  readonly checkout: string
  readonly base: string
  /** Whether `organs.predictor` is on: off, no ticket waits for a guess. */
  readonly enabled: boolean
  /** Wakes the run: a ticket's guess came, or won't. */
  readonly woken: Effect.Effect<void>
}) {
  const git = yield* Git
  const graph = yield* WorkGraph
  const actor: Actor = { _tag: 'organ', organ }
  const questions = yield* FiberSet.make<void>()
  // The tickets weighed this run, each once: a guess lost isn't asked for again, ticket after ticket.
  const weighed = new Set<TicketId>()
  const waiting = yield* Ref.make<ReadonlySet<TicketId>>(new Set())
  // Those of them whose question ended, whose wake is to come.
  const ended = yield* Ref.make<ReadonlySet<TicketId>>(new Set())

  /** Whether the ticket's branch has commits Base hasn't; one git can't tell is taken to. */
  const hasCommits = (ticket: TicketId) =>
    Effect.gen(function* () {
      const branch = ticketBranch(ticket)
      const head = yield* git.commitHash({
        repo: input.checkout,
        revision: branch,
      })
      if (Option.isNone(head)) return false
      const onBase = yield* git.isOnBase({
        repo: input.checkout,
        branch,
        base: input.base,
      })
      return !onBase
    }).pipe(Effect.orElseSucceed(() => true))

  /** Keeps the guess on the ticket, beside what its metadata has by now. */
  const keep = (ticket: TicketId, files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const shown = yield* graph.show(ticket)
      yield* graph.update({
        id: ticket,
        changes: {
          metadata: {
            ...shown.ticket.metadata,
            predicted_files: Option.some(files),
          },
        },
        actor,
      })
    })

  const predict = (
    ticket: PredictedTicket,
    repository: Effect.Effect<Repository>,
  ) =>
    Effect.gen(function* () {
      const outcome = yield* input.organs.ask({
        organ,
        ticket: Option.some(ticket.id),
        answer: PredictorAnswer,
        description,
        instructions,
        prompt: Effect.map(repository, tracked =>
          predictorPrompt(ticket, tracked),
        ),
      })
      yield* OrganOutcome.$match(outcome, {
        Answered: ({ answer }) =>
          Effect.flatMap(repository, tracked =>
            keep(ticket.id, guessedFiles(answer, tracked)),
          ),
        Disabled: () => Effect.void,
        NoResult: () => Effect.void,
      })
    }).pipe(
      // The guess is lost, this ticket's alone.
      Effect.catchCause(cause =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              `ORGAN: the predictor lost ${ticket.id}'s guess: ${Cause.pretty(cause)}`,
            ),
      ),
      Effect.andThen(Ref.update(ended, now => new Set([...now, ticket.id]))),
      Effect.andThen(input.woken),
    )

  const offer: Predictor['offer'] = ({ ready, free }) =>
    Effect.gen(function* () {
      const now = yield* Ref.get(waiting)
      if (!input.enabled || free <= 1) return now
      const asked: Array<PredictedTicket> = []
      const later: Array<TicketId> = []
      for (const candidate of ready) {
        const { ticket } = candidate
        if (!wantsGuess(candidate) || weighed.has(ticket.id)) continue
        if (now.size + asked.length >= free) later.push(ticket.id)
        else {
          weighed.add(ticket.id)
          if (!(yield* hasCommits(ticket.id))) asked.push(ticket)
        }
      }
      // Added to what waits by now: a question may have ended during the reads above.
      const asking = yield* Ref.updateAndGet(
        waiting,
        current => new Set([...current, ...asked.map(({ id }) => id)]),
      )
      if (asked.length > 0) {
        // Base's files, read once for those asked now, within a question so that a failure loses its guess alone.
        const repository = yield* Effect.cached(
          git
            .trackedFiles({ repo: input.checkout, revision: input.base })
            .pipe(Effect.map(makeRepository), Effect.orDie),
        )
        for (const ticket of asked)
          yield* FiberSet.run(questions, predict(ticket, repository))
      }
      return new Set([...asking, ...later])
    })

  return {
    offer,
    asking: Effect.map(Ref.get(waiting), now => now.size > 0),
    reading: read =>
      Effect.gen(function* () {
        const before = yield* Ref.get(ended)
        const result = yield* read
        const left = (now: ReadonlySet<TicketId>) =>
          new Set([...now].filter(id => !before.has(id)))
        yield* Ref.update(waiting, left)
        yield* Ref.update(ended, left)
        return result
      }),
  } satisfies Predictor
})
