import { Data, Effect, Option, Schema, SynchronizedRef } from 'effect'
import { createHash } from 'node:crypto'

import {
  type Actor,
  CommitHash,
  type EngineId,
  type Requirement,
  TicketId,
} from '@fabrica/contracts'

import { readFileText, writeFileWhole } from '../files'
import {
  Git,
  type TicketWorktree,
  type WorktreeHome,
  Worktrees,
  ticketBranch,
  worktreePath,
} from '../git'
import { workerRulesPath } from '../projects/layout'
import { type RunLog, warningLine } from '../runlog'
import { WorkGraph } from '../workgraph'
import { record } from './records'
import type { Started } from './start-checks'

// The carry-over (spec §13.10, §13.2 Resumes take slots, §13.5, H75, H76): the workers and tickets a
// stopped or crashed run left, kept in `.fabrica/run/state.json` (written whole, H84) and the work
// graph's claims. A worker's session is saved once its agent has started, with what it began with
// (the rules' versions, the project's worker rules, the requirements list), and dropped as its ticket
// merges or closes. The next run's start reads the file before it writes anything: a run that left it
// is over, as the engine's lock (one engine on the machine) and the registry (one run of a project)
// say, so its tickets are carried, whatever run the file names (tutti-z3el). For each ticket still in
// progress under this engine's claim, the start aborts a rebase a killed merge, train or hand-back
// left (its branch put back), drops one already on Base (closed, its worktree and branch removed),
// puts a finished one back in line to merge, and releases the rest to the queue, where each resumes
// its session as a dispatch does, through the ready rule, the footprints and a free slot. A stop
// during this cuts it short: the rest stay as they were, for the next start (tutti-5mp). A resumed
// session is told why it resumed and what changed since it began (§12.4).

/** Where the run keeps its saved sessions, from the checkout's top. */
export const runStatePath = '.fabrica/run/state.json'

/** What a session began with, so a resume says what changed since (§12.4). */
const Began = Schema.Struct({
  /** The versions of the templates init wrote, by template (`settings.templates`). */
  templates: Schema.Record(Schema.String, Schema.Number),
  /** A digest of the project's worker rules on Base; none where it has none. */
  projectRules: Schema.OptionFromNullOr(Schema.String),
  /** The requires list's entries, each in words. */
  requirements: Schema.Array(
    Schema.Struct({ name: Schema.String, entry: Schema.String }),
  ),
})
export type Began = typeof Began.Type

/** Where a saved session's ticket stood when it was last saved. */
export const SessionLeft = Schema.TaggedUnion({
  /** Its worker was working on it. */
  working: {},
  /** It finished, and waited to merge. */
  finished: {},
  /** Its worker asked `question` about it. */
  asked: { question: TicketId },
  /** It waits for another ticket to merge: it starts afresh then, in its worktree rebased onto Base. */
  waits: {},
  /** It was set aside: deferred, or left for review. */
  set_aside: {},
})
export type SessionLeft = typeof SessionLeft.Type

/** A ticket's saved session. */
export const SavedSession = Schema.Struct({
  ticket: TicketId,
  /** The session's file, which Pi's `switch_session` resumes. */
  session: Schema.String,
  /** The Base commit its worktree was prepared from: a branch moved past it and on Base is merged. */
  base: CommitHash,
  left: SessionLeft,
  began: Began,
})
export type SavedSession = typeof SavedSession.Type

const RunStateFile = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(SavedSession),
})
const RunStateJson = Schema.fromJsonString(RunStateFile)
const decodeRunState = Schema.decodeUnknownOption(RunStateJson)
const encodeRunState = Schema.encodeSync(RunStateJson)

/** The most the state file may hold to be read. */
const stateMaxBytes = 4 * 1024 * 1024

const location = (checkout: string) => ({
  root: checkout,
  path: runStatePath,
})

/** A requires list's entry in words: its check and what meets it, so a change to either shows. */
const entryWords = (requirement: Requirement): string =>
  [
    requirement.check,
    requirement.meets._tag === 'Install'
      ? `install: ${requirement.meets.command}`
      : `manual: ${requirement.meets.instruction}`,
    ...Option.match(requirement.platforms, {
      onNone: () => [],
      onSome: platforms => [`on ${platforms.join(', ')}`],
    }),
  ].join('; ')

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

/** What a session begins with now: the run's settings, and the project's worker rules on Base. */
export const beganNow = Effect.fn('CarryOver.beganNow')(function* (input: {
  readonly checkout: string
  readonly started: Started
}) {
  const project = input.started.settings.project
  const rules = yield* readFileText({
    root: input.checkout,
    path: workerRulesPath,
  }).pipe(
    Effect.map(text => Option.some(digest(text))),
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  return {
    templates: project.templates,
    projectRules: rules,
    requirements: project.requires.map(requirement => ({
      name: requirement.name,
      entry: entryWords(requirement),
    })),
  } satisfies Began
})

/** What changed between `then` and `now`, in words; none where nothing did. */
export const changesSince = (
  then: Began,
  now: Began,
): ReadonlyArray<string> => {
  const templates = [
    ...new Set([...Object.keys(then.templates), ...Object.keys(now.templates)]),
  ]
    .toSorted()
    .flatMap(name => {
      const before = then.templates[name]
      const after = now.templates[name]
      return before === after
        ? []
        : [`${name} ${before ?? 'none'} → ${after ?? 'none'}`]
    })
  const before = new Map(
    then.requirements.map(({ name, entry }) => [name, entry]),
  )
  const after = new Map(
    now.requirements.map(({ name, entry }) => [name, entry]),
  )
  const added = [...after.keys()].filter(name => !before.has(name))
  const removed = [...before.keys()].filter(name => !after.has(name))
  const changed = [...after.keys()].filter(
    name => before.has(name) && before.get(name) !== after.get(name),
  )
  const requirements = [
    ...(added.length === 0 ? [] : [`added ${added.join(', ')}`]),
    ...(removed.length === 0 ? [] : [`removed ${removed.join(', ')}`]),
    ...(changed.length === 0 ? [] : [`changed ${changed.join(', ')}`]),
  ]
  return [
    ...(templates.length === 0
      ? []
      : [`the standing rules' templates changed: ${templates.join('; ')}`]),
    ...(Option.getOrNull(then.projectRules) ===
    Option.getOrNull(now.projectRules)
      ? []
      : [`the project's worker rules (${workerRulesPath}) changed on Base`]),
    ...(requirements.length === 0
      ? []
      : [`the requirements list changed: ${requirements.join('; ')}`]),
  ]
}

/** Why a session resumes, as its resume message says it. */
export type ResumeWhy = Data.TaggedEnum<{
  /** An earlier run stopped, or ended, with its worker at work. */
  Carried: {}
  /** The question its worker asked was answered. */
  Answered: { readonly question: TicketId; readonly answer: string }
  /** It was set aside, and undeferred. */
  Undeferred: {}
}>
export const ResumeWhy = Data.taggedEnum<ResumeWhy>()

/** Why a session resumes, in the log's words. */
export const resumeWords: (why: ResumeWhy) => string = ResumeWhy.$match({
  Carried: () => 'carried over',
  Answered: ({ question }) => `${question} answered`,
  Undeferred: () => 'undeferred',
})

/** A resumed session's message: why it resumed, what changed since it began, and to carry on. */
export const resumePrompt = (input: {
  readonly ticket: TicketId
  readonly why: ResumeWhy
  readonly changes: ReadonlyArray<string>
}): string =>
  [
    `Your session on ${input.ticket} is resumed: ${ResumeWhy.$match(input.why, {
      Carried: () => 'the run that had it ended before you finished.',
      Answered: ({ question, answer }) =>
        `your question ${question} was answered: ${answer}`,
      Undeferred: () => 'it was set aside, and is undeferred.',
    })}`,
    input.changes.length === 0
      ? 'Nothing in the standing rules, the project’s worker rules or the requirements list changed since your session began.'
      : `Since your session began: ${input.changes.join('; ')}. Read them again before you go on: your system prompt may still have the old ones.`,
    'Carry on with your ticket from where you left it, and end your turn through an outcome tool.',
  ].join('\n\n')

export interface CarrySessionsShape {
  /** Every saved session. */
  readonly all: Effect.Effect<ReadonlyArray<SavedSession>>
  /** The ticket's saved session, if any. */
  readonly saved: (
    ticket: TicketId,
  ) => Effect.Effect<Option.Option<SavedSession>>
  /** Saves the ticket's session, as its agent started. */
  readonly save: (session: SavedSession) => Effect.Effect<void>
  /** Says where the ticket stands now, its session kept. */
  readonly left: (input: {
    readonly ticket: TicketId
    readonly left: SessionLeft
  }) => Effect.Effect<void>
  /** Drops the ticket's session: its part is over, or it starts afresh. */
  readonly drop: (ticket: TicketId) => Effect.Effect<void>
}

/**
 * The saved sessions of the run, from `sessions`: each change writes the file whole while it holds
 * them, so the file is never written from a copy read before another change. A write that fails is
 * logged, and the run goes on: a lost save costs a fresh start, never the run.
 */
const makeCarrySessions = Effect.fn('CarryOver.sessions')(function* (
  checkout: string,
  sessions: ReadonlyArray<SavedSession>,
) {
  const state = yield* SynchronizedRef.make<
    ReadonlyMap<TicketId, SavedSession>
  >(new Map(sessions.map(session => [session.ticket, session])))
  const written = (sessionsNow: ReadonlyMap<TicketId, SavedSession>) =>
    writeFileWhole(
      location(checkout),
      `${encodeRunState({ version: 1, sessions: [...sessionsNow.values()] })}\n`,
    ).pipe(
      Effect.catch(error =>
        Effect.logWarning(
          `the run's saved sessions couldn't be written: ${error.message}`,
        ),
      ),
    )
  const change = (
    f: (
      current: ReadonlyMap<TicketId, SavedSession>,
    ) => ReadonlyMap<TicketId, SavedSession>,
  ) =>
    SynchronizedRef.updateEffect(state, current => {
      const next = f(current)
      return next === current
        ? Effect.succeed(current)
        : Effect.as(written(next), next)
    })
  return {
    all: Effect.map(SynchronizedRef.get(state), current => [
      ...current.values(),
    ]),
    saved: ticket =>
      Effect.map(SynchronizedRef.get(state), current =>
        Option.fromUndefinedOr(current.get(ticket)),
      ),
    save: session =>
      change(current => new Map(current).set(session.ticket, session)),
    left: ({ ticket, left }) =>
      change(current => {
        const saved = current.get(ticket)
        return saved === undefined
          ? current
          : new Map(current).set(ticket, { ...saved, left })
      }),
    drop: ticket =>
      change(current => {
        if (!current.has(ticket)) return current
        const next = new Map(current)
        next.delete(ticket)
        return next
      }),
  } satisfies CarrySessionsShape
})

/** The saved sessions the file holds; none where it is missing, and none, said, where it can't be read. */
const readSaved = Effect.fn('CarryOver.read')(function* (
  checkout: string,
  log: RunLog['Service'],
) {
  const text = yield* readFileText(location(checkout), {
    maxBytes: stateMaxBytes,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag('FileMissing', () => Effect.succeedNone),
    Effect.catch(error =>
      Effect.as(
        record(log, {
          kind: 'warn',
          text: warningLine({
            tag: 'CARRY_OVER',
            about: 'run',
            text: `${runStatePath} can't be read, so no session is resumed: ${error.message}`,
          }),
        }),
        Option.none<string>(),
      ),
    ),
  )
  if (Option.isNone(text)) return []
  const decoded = decodeRunState(text.value)
  if (Option.isNone(decoded)) {
    yield* record(log, {
      kind: 'warn',
      text: warningLine({
        tag: 'CARRY_OVER',
        about: 'run',
        text: `${runStatePath} isn't a run's state, so no session is resumed`,
      }),
    })
    return []
  }
  return decoded.value.sessions
})

/**
 * The commit of the ticket's branch where its work is on Base: the branch moved past `from`, the
 * Base commit it was prepared from, and Base has it. None where it hasn't, or git can't tell.
 */
export const mergedOnBase = Effect.fn('CarryOver.mergedOnBase')(
  function* (input: {
    readonly checkout: string
    readonly base: string
    readonly ticket: TicketId
    readonly from: CommitHash
  }) {
    const git = yield* Git
    const branch = ticketBranch(input.ticket)
    const tip = yield* git
      .commitHash({ repo: input.checkout, revision: `refs/heads/${branch}` })
      .pipe(Effect.orElseSucceed(() => Option.none<CommitHash>()))
    if (Option.isNone(tip) || tip.value === input.from)
      return Option.none<CommitHash>()
    const onBase = yield* git
      .isOnBase({ repo: input.checkout, branch, base: input.base })
      .pipe(Effect.orElseSucceed(() => false))
    return onBase ? tip : Option.none<CommitHash>()
  },
)

/**
 * Counts a ticket whose branch is on Base as merged (orchestra-nr1v.8, -nr1v.9): its merged commit
 * recorded, closed (its claim dropped, what it blocks freed), its worktree and branch removed, its
 * saved session dropped.
 */
export const closeMerged = Effect.fn('CarryOver.closeMerged')(
  function* (input: {
    readonly home: WorktreeHome
    readonly ticket: TicketId
    readonly commit: CommitHash
    readonly sessions: CarrySessionsShape
    readonly actor: Actor
    readonly why: string
  }) {
    const graph = yield* WorkGraph
    const worktrees = yield* Worktrees
    yield* graph.update({
      id: input.ticket,
      changes: { mergedCommit: Option.some(input.commit) },
      actor: input.actor,
    })
    yield* graph
      .close({
        id: input.ticket,
        resolution: 'done',
        reason: input.why,
        actor: input.actor,
      })
      .pipe(Effect.catchTag('TransitionRefused', () => Effect.void))
    yield* worktrees
      .remove({ home: input.home, ticket: input.ticket })
      .pipe(
        Effect.catch(error =>
          Effect.logWarning(
            `${input.ticket}'s worktree and branch couldn't be removed: ${error.message}`,
          ),
        ),
      )
    yield* input.sessions.drop(input.ticket)
  },
)

/** What the start's carry-over left for the run. */
export interface CarriedOver {
  /** The run's saved sessions, from now on. */
  readonly sessions: CarrySessionsShape
  /** Finished tickets, back in line to merge. */
  readonly toMerge: ReadonlyArray<TicketWorktree>
  /** Tickets back in the queue, each to resume its session as a slot frees. */
  readonly toResume: ReadonlyArray<TicketId>
  /** Tickets already on Base, closed. */
  readonly merged: ReadonlyArray<TicketId>
  /** A stop cut it short: the tickets it hadn't come to stay as they were. */
  readonly cutShort: boolean
}

/** What a carry-over found of the tickets an earlier run left. */
type Carry = Data.TaggedEnum<{
  Merge: { readonly worktree: TicketWorktree }
  Resume: {}
  Merged: {}
}>
const Carry = Data.taggedEnum<Carry>()

/**
 * The start's carry-over (§13.10): the saved sessions read before anything writes them, then each
 * ticket in progress under this engine's claim taken up, until `stopping` says the run is stopped.
 */
export const carryOver = Effect.fn('CarryOver.start')(function* (input: {
  readonly checkout: string
  readonly home: WorktreeHome
  readonly base: string
  readonly engine: EngineId
  readonly actor: Actor
  readonly log: RunLog['Service']
  readonly stopping: Effect.Effect<boolean>
}) {
  const graph = yield* WorkGraph
  const git = yield* Git
  const worktrees = yield* Worktrees
  const { log } = input
  const found = yield* readSaved(input.checkout, log)
  const sessions = yield* makeCarrySessions(input.checkout, found)
  // A session whose ticket is gone or closed has nothing left to resume.
  yield* Effect.forEach(
    found,
    saved =>
      graph.show(saved.ticket).pipe(
        Effect.map(({ ticket }) => ticket.status === 'closed'),
        Effect.catchTag('TicketNotFound', () => Effect.succeed(true)),
        Effect.orElseSucceed(() => false),
        Effect.flatMap(over =>
          over ? sessions.drop(saved.ticket) : Effect.void,
        ),
      ),
    { discard: true },
  )
  // The work graph unread, nothing is carried: its tickets stay in progress, for the next start.
  const claimed = (yield* graph.list({ statuses: ['in_progress'] }).pipe(
    Effect.catch(error =>
      Effect.as(
        record(log, {
          kind: 'warn',
          text: warningLine({
            tag: 'CARRY_OVER',
            about: 'run',
            text: `the tickets in progress can't be read, so none is carried over: ${error.message}`,
          }),
        }),
        [],
      ),
    ),
  )).filter(ticket =>
    Option.exists(ticket.assignee, ({ engine }) => engine === input.engine),
  )
  const say = (text: string) =>
    record(log, { kind: 'info', text: `start: the carry-over: ${text}` })

  /**
   * Aborts a rebase left in progress in the ticket's worktree, putting its branch back, so the ticket
   * merges rebased afresh (tutti-m31, -tejt, -b8hv). Read at the worktree's place: mid-rebase, its
   * HEAD is no branch's, and the worktrees' list doesn't name it its ticket's.
   */
  const abortLeftRebase = (ticket: TicketId) =>
    Effect.gen(function* () {
      const path = worktreePath({ home: input.home, ticket })
      const rebasing = yield* git
        .isRebasing({ worktree: path })
        .pipe(Effect.orElseSucceed(() => false))
      if (!rebasing) return
      yield* git.abortRebase({ worktree: path }).pipe(
        Effect.andThen(
          say(
            `${ticket}'s rebase, left in progress, aborted: its branch is put back`,
          ),
        ),
        Effect.catch(error =>
          record(log, {
            kind: 'warn',
            ticket,
            text: warningLine({
              tag: 'CARRY_OVER',
              about: 'ticket',
              text: `${ticket}'s rebase, left in progress, couldn't be aborted: ${error.message}`,
            }),
          }),
        ),
      )
    })

  // The leftover rebases first, so the worktrees are listed on their branches.
  let cutShort = false
  for (const ticket of claimed) {
    if (yield* input.stopping) {
      cutShort = true
      break
    }
    yield* abortLeftRebase(ticket.id)
  }
  const listed =
    claimed.length === 0 || cutShort
      ? []
      : yield* worktrees
          .list({ home: input.home })
          .pipe(
            Effect.catch(error =>
              Effect.as(
                Effect.logWarning(
                  `the carried tickets' worktrees can't be listed: ${error.message}`,
                ),
                [],
              ),
            ),
          )
  /** One carried ticket: merged already, back in line to merge, or back in the queue. */
  const carryOne = (ticket: TicketId) =>
    Effect.gen(function* () {
      const worktree = listed.find(entry => entry.ticket === ticket)
      const saved = yield* sessions.saved(ticket)
      if (Option.isSome(saved) && worktree !== undefined) {
        const commit = yield* mergedOnBase({
          checkout: input.checkout,
          base: input.base,
          ticket,
          from: saved.value.base,
        })
        if (Option.isSome(commit)) {
          yield* closeMerged({
            home: input.home,
            ticket,
            commit: commit.value,
            sessions,
            actor: input.actor,
            why: `Already on ${input.base} as the run started: carried over, merged.`,
          })
          yield* say(
            `${ticket} is on ${input.base} already: closed, its worktree and branch removed`,
          )
          return Carry.Merged()
        }
        if (saved.value.left._tag === 'finished')
          return Carry.Merge({ worktree })
      }
      // No worktree, no session to resume in it: it starts afresh.
      if (Option.isSome(saved) && worktree === undefined)
        yield* sessions.drop(ticket)
      yield* graph.release({ id: ticket, actor: input.actor })
      return Carry.Resume()
    })

  const toMerge: Array<TicketWorktree> = []
  const toResume: Array<TicketId> = []
  const merged: Array<TicketId> = []
  for (const ticket of cutShort ? [] : claimed) {
    if (yield* input.stopping) {
      cutShort = true
      break
    }
    const carried = yield* carryOne(ticket.id).pipe(
      Effect.map(Option.some),
      // One ticket the work graph or git failed under stays in progress, for the next start.
      Effect.catch(error =>
        Effect.as(
          record(log, {
            kind: 'warn',
            ticket: ticket.id,
            text: warningLine({
              tag: 'CARRY_OVER',
              about: 'ticket',
              text: `${ticket.id} isn't carried over: ${error.message}`,
            }),
          }),
          Option.none<Carry>(),
        ),
      ),
    )
    if (Option.isNone(carried)) continue
    Carry.$match(carried.value, {
      Merge: ({ worktree }) => toMerge.push(worktree),
      Resume: () => toResume.push(ticket.id),
      Merged: () => merged.push(ticket.id),
    })
  }
  return { sessions, toMerge, toResume, merged, cutShort } satisfies CarriedOver
})
