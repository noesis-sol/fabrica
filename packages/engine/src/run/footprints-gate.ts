import { Effect, Option } from 'effect'

import {
  type CommandSetting,
  type CommitHash,
  type HoldBack,
  type LabelName,
  Phase,
  type Ticket,
  type TicketId,
  factsOf,
} from '@fabrica/contracts'

import {
  type ApartFiles,
  type Declared,
  type Footprint,
  type Mentions,
  Overlap,
  type Repository,
  branchFootprint,
  checkFiles,
  describeShared,
  makeApartFiles,
  makeRepository,
  namesFunctions,
  overlap,
  readDeclared,
  readMentions,
  readerIn,
  ticketFootprint,
  withChanges,
} from '../footprints'
import { Git, type WorktreeHome, ticketBranch, worktreePath } from '../git'
import { type StoreFailed, WorkGraph } from '../workgraph'
import { type RunSnapshot, inProgress } from './state'

// The footprints gate (spec §13.4, H70, H81): which ready tickets may be dispatched beside those the
// run has, and why each other is held back, in words as the log says them. A ready ticket
// overlapping a ticket in progress (running, merging or waiting to merge), or one dispatched before
// it in the same look, is held back; every ready ticket waits while a `solo` ticket runs or waits
// first in line, and a solo ticket starts only with nothing else in progress. A ticket past its work
// holds on the files its branch changed, not on what its `files` or text named, and holds no slot:
// while `concurrent` such tickets wait to merge, nothing more is dispatched (orchestra-z8lr).

/** The label of a ticket that runs alone. */
export const soloLabel = 'solo'

/** A ready ticket as the gate weighs it: where it works, and whether it runs alone. */
export interface ReadyTicket {
  readonly ticket: Ticket
  readonly footprint: Footprint
  readonly solo: boolean
}

/** A ticket the run has in progress as the gate weighs it: its footprint as its phase gives it. */
export interface RunTicket {
  readonly ticket: TicketId
  readonly phase: Phase
  readonly footprint: Footprint
  readonly solo: boolean
}

/** Files a ticket dispatched shares with one in progress that hold no tickets apart (`LIKELY_CONFLICT`). */
export interface LikelyConflict {
  readonly with: TicketId
  readonly files: readonly [string, ...Array<string>]
}

/** A ready ticket the gate lets through, with its footprint for the log's footprint line. */
export interface Taken extends ReadyTicket {
  readonly likely: ReadonlyArray<LikelyConflict>
}

/** A ready ticket held back, and why in words, as the log says it (H81). */
export interface HeldBack {
  readonly ticket: TicketId
  readonly reason: HoldBack
  readonly detail: string
}

/** The solo ticket the run has, running or next in line. */
export interface SoloInLine {
  readonly ticket: TicketId
  readonly next: boolean
}

/** What the gate let through, most urgent first, what it held back, and the solo ticket in line. */
export interface Gated {
  readonly take: ReadonlyArray<Taken>
  readonly held: ReadonlyArray<HeldBack>
  readonly solo: Option.Option<SoloInLine>
}

/** How a reason names a ticket in progress by its phase (`running fa-7`); none for one not in progress. */
const namedAs: (phase: Phase) => Option.Option<(ticket: TicketId) => string> =
  Phase.match({
    queued: () => Option.none(),
    held_back: () => Option.none(),
    waiting: () => Option.none(),
    working: () => Option.some(ticket => `running ${ticket}`),
    verifying: () => Option.some(ticket => `running ${ticket}`),
    waiting_to_merge: () => Option.some(ticket => `${ticket} waiting to merge`),
    merging: () => Option.some(ticket => `merging ${ticket}`),
    resolving: () => Option.some(ticket => `merging ${ticket}`),
    fixing: () => Option.some(ticket => `merging ${ticket}`),
    asked: () => Option.none(),
    set_aside: () => Option.none(),
    stopped: () => Option.none(),
    merged: () => Option.none(),
    no_change: () => Option.none(),
  })

/** A ticket a ready one is weighed against, and how a reason names it. */
interface Beside {
  readonly ticket: TicketId
  readonly footprint: Footprint
  readonly named: string
}

/**
 * Gates the ready tickets, most urgent first, against the tickets the run has in progress: at most
 * `free` taken, none while `concurrent` tickets are past their work. Pure: what it reads is given.
 */
export const gate = (input: {
  readonly ready: ReadonlyArray<ReadyTicket>
  readonly running: ReadonlyArray<RunTicket>
  readonly free: number
  readonly concurrent: number
  readonly mentions: Mentions
  readonly apart: ApartFiles
}): Gated => {
  const pastWork = input.running.filter(
    ({ phase }) => factsOf(phase).pastWork,
  ).length
  let room = pastWork >= input.concurrent ? 0 : Math.max(0, input.free)
  const take: Array<Taken> = []
  const held: Array<HeldBack> = []
  const beside: Array<Beside> = input.running.flatMap(running =>
    Option.match(namedAs(running.phase), {
      onNone: () => [],
      onSome: name => [
        {
          ticket: running.ticket,
          footprint: running.footprint,
          named: name(running.ticket),
        },
      ],
    }),
  )
  let solo = Option.map(
    Option.fromUndefinedOr(input.running.find(running => running.solo)),
    (running): SoloInLine => ({ ticket: running.ticket, next: false }),
  )
  for (const candidate of input.ready) {
    const id = candidate.ticket.id
    if (Option.isSome(solo)) {
      held.push({
        ticket: id,
        reason: 'solo',
        detail: `waits for the solo ticket ${solo.value.ticket}`,
      })
      continue
    }
    if (candidate.solo) {
      const busy = beside.map(({ ticket }) => ticket)
      const starts = busy.length === 0 && room > 0
      solo = Option.some({ ticket: id, next: !starts })
      if (starts) {
        take.push({ ...candidate, likely: [] })
        room -= 1
      } else if (busy.length > 0)
        held.push({
          ticket: id,
          reason: 'solo',
          detail: `waits to run alone, after ${busy.join(', ')}`,
        })
      continue
    }
    let holding = Option.none<string>()
    const likely: Array<LikelyConflict> = []
    for (const other of beside) {
      const met = overlap({
        a: candidate.footprint,
        b: other.footprint,
        mentions: input.mentions,
        apart: input.apart,
      })
      holding = Overlap.$match(met, {
        Clear: () => Option.none<string>(),
        LikelyConflict: ({ files }) => {
          likely.push({ with: other.ticket, files })
          return Option.none<string>()
        },
        Holds: ({ on }) =>
          Option.some(`touches ${describeShared(on)}, like ${other.named}`),
      })
      if (Option.isSome(holding)) break
    }
    if (Option.isSome(holding)) {
      held.push({ ticket: id, reason: 'overlap', detail: holding.value })
      continue
    }
    if (room <= 0) continue
    room -= 1
    take.push({ ...candidate, likely })
    beside.push({
      ticket: id,
      footprint: candidate.footprint,
      named: `running ${id}`,
    })
  }
  return { take, held, solo }
}

/** What the run gates: its ready tickets, most urgent first, against its state. */
export interface GateInput {
  readonly ready: ReadonlyArray<Ticket>
  readonly snapshot: RunSnapshot
  /** The slots free, as the run's holds allow. */
  readonly free: number
}

/** The gate over the run's state: it reads each footprint, and Base's files once per Base commit. */
export interface FootprintsGate {
  readonly gate: (input: GateInput) => Effect.Effect<Gated, StoreFailed>
}

/** What footprints read at one Base commit. */
interface AtBase {
  readonly commit: Option.Option<CommitHash>
  readonly repository: Repository
  readonly apart: ApartFiles
  declared: Option.Option<Declared>
}

/** What a footprint is read from: none declared until a ticket names a function. */
const noneDeclared: Declared = { declares: () => false }

/** Reads at most this many tickets' footprints at once. */
const readsAtOnce = 4

const isSolo = (labels: ReadonlyArray<LabelName>): boolean =>
  labels.includes(soloLabel)

/** Gates the ready tickets against the run's state, read through Git and the work graph. */
const gateReady = (
  input: GateInput,
  reads: {
    readonly git: Git['Service']
    readonly graph: WorkGraph['Service']
    readonly checkout: string
    readonly home: WorktreeHome
    readonly base: string
    readonly concurrent: number
    readonly atBase: Effect.Effect<AtBase>
  },
): Effect.Effect<Gated, StoreFailed> =>
  Effect.gen(function* () {
    const { git, graph, checkout, home } = reads
    const at = yield* reads.atBase
    const revision = Option.getOrElse(at.commit, () => reads.base)
    const shown = (id: TicketId) =>
      graph.show(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag('TicketNotFound', () => Effect.succeed(Option.none())),
      )
    const changed = (id: TicketId) =>
      git
        .changedFiles({
          repo: checkout,
          branch: ticketBranch(id),
          base: revision,
        })
        .pipe(Effect.option)
    const worktreeChanges = (id: TicketId) =>
      git.status({ worktree: worktreePath({ home, ticket: id }) }).pipe(
        Effect.map(status => [...status.uncommitted, ...status.untracked]),
        Effect.orElseSucceed(() => []),
      )

    const readyShown = yield* Effect.forEach(
      input.ready,
      ticket =>
        Effect.map(shown(ticket.id), detail => ({
          ticket,
          labels: Option.match(detail, {
            onNone: () => [],
            onSome: ({ labels }) => labels,
          }),
        })),
      { concurrency: readsAtOnce },
    )
    const runningShown = yield* Effect.forEach(
      inProgress(input.snapshot),
      taken =>
        Effect.gen(function* () {
          const detail = yield* shown(taken.ticket)
          const labels = Option.match(detail, {
            onNone: () => [],
            onSome: ({ labels }) => labels,
          })
          return { taken, detail, labels }
        }),
      { concurrency: readsAtOnce },
    )

    // Base's declarations are read once per Base, and only where a ticket without `files` names a function.
    const named = [
      ...readyShown.map(({ ticket, labels }) => ({ ticket, labels })),
      ...runningShown.flatMap(({ detail, labels }) =>
        Option.match(detail, {
          onNone: () => [],
          onSome: ({ ticket }) => [{ ticket, labels }],
        }),
      ),
    ]
    if (
      Option.isNone(at.declared) &&
      named.some(ticket =>
        namesFunctions({ ticket, repository: at.repository }),
      )
    )
      at.declared = Option.some(
        yield* readDeclared({
          repository: at.repository,
          read: readerIn(checkout),
        }),
      )
    const declared = Option.getOrElse(at.declared, () => noneDeclared)
    const footprintOf = (ticket: Ticket, labels: ReadonlyArray<LabelName>) =>
      ticketFootprint({
        ticket: { ticket, labels },
        repository: at.repository,
        declared,
      })

    const ready = readyShown.map(({ ticket, labels }): ReadyTicket => ({
      ticket,
      footprint: footprintOf(ticket, labels),
      solo: isSolo(labels),
    }))
    const running = yield* Effect.forEach(
      runningShown,
      ({ taken, detail, labels }) =>
        Effect.gen(function* () {
          const branch = yield* changed(taken.ticket)
          const own = Option.map(detail, ({ ticket }) =>
            footprintOf(ticket, labels),
          )
          // Past its work, the branch is the truth; a branch git can't tell keeps its footprint whole.
          const footprint = factsOf(taken.phase).pastWork
            ? Option.match(branch, {
                onSome: files =>
                  branchFootprint({
                    labels,
                    changed: files,
                    repository: at.repository,
                  }),
                onNone: () =>
                  Option.getOrElse(own, () =>
                    branchFootprint({
                      labels,
                      changed: [],
                      repository: at.repository,
                    }),
                  ),
              })
            : withChanges({
                footprint: Option.getOrElse(own, () =>
                  branchFootprint({
                    labels,
                    changed: [],
                    repository: at.repository,
                  }),
                ),
                changed: [
                  ...Option.getOrElse(branch, () => []),
                  ...(yield* worktreeChanges(taken.ticket)),
                ],
                repository: at.repository,
              })
          return {
            ticket: taken.ticket,
            phase: taken.phase,
            footprint,
            solo: isSolo(labels),
          } satisfies RunTicket
        }),
      { concurrency: readsAtOnce },
    )

    const mentions = yield* readMentions({
      pairs: ready.flatMap(a =>
        [...running, ...ready]
          .filter(b => b !== a)
          .map(b => [a.footprint, b.footprint] as const),
      ),
      read: readerIn(checkout),
    })
    return gate({
      ready,
      running,
      free: input.free,
      concurrent: reads.concurrent,
      mentions,
      apart: at.apart,
    })
  })

/** The run's footprints gate, over the checkout and its Base, for the project's settings. */
export const makeFootprintsGate = Effect.fn('FootprintsGate.make')(
  function* (input: {
    readonly checkout: string
    readonly home: WorktreeHome
    readonly base: string
    readonly concurrent: number
    /** The check commands: `check_own`, `check_fast` and `check_full`. */
    readonly checks: ReadonlyArray<CommandSetting>
    readonly sharedFiles: ReadonlyArray<string>
  }) {
    const git = yield* Git
    const graph = yield* WorkGraph
    const read = readerIn(input.checkout)
    const commands = input.checks.flatMap(check =>
      check._tag === 'Command' ? [check.command] : [],
    )
    let last = Option.none<AtBase>()

    /** What footprints read at Base's commit now: the last read again while Base hasn't moved. */
    const atBase = Effect.gen(function* () {
      const commit = yield* git
        .commitHash({ repo: input.checkout, revision: input.base })
        .pipe(Effect.orElseSucceed(() => Option.none<CommitHash>()))
      const seen = Option.filter(
        last,
        at =>
          Option.isSome(commit) &&
          Option.exists(at.commit, read => read === commit.value),
      )
      if (Option.isSome(seen)) return seen.value
      const revision = Option.getOrElse(commit, () => input.base)
      const [tracked, unioned] = yield* Effect.all(
        [
          git
            .trackedFiles({ repo: input.checkout, revision })
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
          git
            .unionMerged({ repo: input.checkout, revision })
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
        ],
        { concurrency: 2 },
      )
      const repository = makeRepository(tracked)
      const checks = yield* checkFiles({ commands, repository, read })
      const at: AtBase = {
        commit,
        repository,
        apart: makeApartFiles({
          unioned,
          checks,
          shared: input.sharedFiles,
        }),
        declared: Option.none(),
      }
      last = Option.some(at)
      return at
    })

    return {
      gate: gated =>
        gateReady(gated, {
          git,
          graph,
          checkout: input.checkout,
          home: input.home,
          base: input.base,
          concurrent: input.concurrent,
          atBase,
        }),
    } satisfies FootprintsGate
  },
)
