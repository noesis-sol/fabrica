import { Duration, Effect, Option, Ref, type Stream } from 'effect'

import type { ProviderName, TicketId } from '@fabrica/contracts'

import { Git } from '../git'
import type { CredentialsHoldShape, UsageHoldShape } from '../holds'
import { DEFAULT_ORGAN_LIMITS, makeOrganRuntime } from '../organs'
import type { RunLog } from '../runlog'
import {
  BreakdownEnd,
  type CommittedSpec,
  type ReadSpec,
  SpecState,
  commitSpec,
  needsBreakdown,
  readSpec,
  rootOf,
  runBreakdown,
  specState,
} from '../spec'
import type { Steps } from '../view/steps'
import type { WorkGraphShape } from '../workgraph'
import type { RunConfig } from './config'
import { record } from './records'
import type { Started } from './start-checks'

// A run's `--spec` mode (spec §13.1, §15.5): the spec read with the start checks, committed once they
// pass, and its state read from the work graph. The run takes the tickets under the root epic, as
// `--ticket <root epic>` does, starting on the environment ticket as soon as the breakdown files it;
// while the breakdown goes on, the run waits for the rest rather than end, and a breakdown that fails
// stops the run, what it filed staying filed for the next run to carry on from.

/** How long one turn of a breakdown may take, a hold's wait not counted. */
export const breakdownTurn = Duration.hours(1)

/** The spec as the start checks found it. */
export interface SpecFound {
  readonly read: ReadSpec
  readonly state: SpecState
}

/** The spec, committed, as the run goes on with it. */
export interface SpecStarted {
  readonly spec: CommittedSpec
  readonly state: SpecState
}

/** The start checks' reading of the spec, or the problem with it; nothing is changed yet. */
export const findSpec = Effect.fn('Spec.find')(function* (input: {
  readonly checkout: string
  readonly given: string
  readonly graph: WorkGraphShape
}) {
  const { checkout, given, graph } = input
  const read = yield* readSpec({ checkout, given })
  const state = yield* specState({
    graph,
    path: read.path,
    sha256: read.sha256,
  })
  return { read, state } satisfies SpecFound
})

/** The spec committed on Base, once every start check has passed. */
export const startSpec = Effect.fn('Spec.start')(function* (input: {
  readonly checkout: string
  readonly found: SpecFound
}) {
  const spec = yield* commitSpec({
    checkout: input.checkout,
    spec: input.found.read,
  })
  return { spec, state: input.found.state } satisfies SpecStarted
})

/** The spec's fields on the run's `start` record: its path, its URL, its root epic where it has one. */
export const specStartFields = (spec: Option.Option<SpecStarted>) =>
  Option.match(spec, {
    onNone: () => ({}),
    onSome: ({ spec: committed, state }) => ({
      spec: committed.path,
      ...Option.match(committed.url, {
        onNone: () => ({}),
        onSome: spec_source => ({ spec_source }),
      }),
      ...Option.match(rootOf(state), {
        onNone: () => ({}),
        onSome: scope => ({ scope }),
      }),
    }),
  })

/** What the run asks of its spec. */
export interface SpecMode {
  /** The root epic, the run's scope; none until the breakdown files it. */
  readonly root: Effect.Effect<Option.Option<TicketId>>
  /** Whether the breakdown is under way, which keeps the run from ending. */
  readonly going: Effect.Effect<boolean>
  /** Runs what the spec needs to its end: forked with the run. */
  readonly run: Effect.Effect<void, unknown, never>
}

/** A run of another mode: nothing to wait for, no scope of a root epic. */
const noSpecMode: SpecMode = {
  root: Effect.succeedNone,
  going: Effect.succeed(false),
  run: Effect.void,
}

/** Makes the run's side of its spec; a run of another mode has nothing to wait for. */
export const makeSpecMode = Effect.fn('Spec.mode')(function* (input: {
  readonly config: RunConfig
  readonly started: Started
  readonly graph: WorkGraphShape
  readonly log: RunLog['Service']
  readonly steps: Pick<Steps, 'during'>
  readonly holds: {
    readonly usage: Pick<UsageHoldShape, 'waitOut'>
    readonly credentials: Pick<CredentialsHoldShape, 'waitOut'>
    readonly held: Stream.Stream<ReadonlySet<ProviderName>>
  }
  /** Stops the run, a setup problem, saying why. */
  readonly stop: (detail: string) => Effect.Effect<void>
  /** Wakes the run to look at what it has to do. */
  readonly woken: Effect.Effect<void>
}) {
  const { config, started, graph, log, steps, holds, stop, woken } = input
  if (Option.isNone(started.spec)) return noSpecMode
  const { spec, state } = started.spec.value
  const project = started.settings.project
  const git = yield* Git
  const root = yield* Ref.make(rootOf(state))
  const going = yield* Ref.make(needsBreakdown(state))
  const runtime = yield* makeOrganRuntime({
    project: config.project,
    run: log.run,
    checkout: config.checkout,
    projectTrusted: config.projectTrusted,
    sockets: config.sockets,
    settings: project,
    log: Option.some(log),
    holds: Option.some(holds),
    billing: () => 'api_key',
    limits: { ...DEFAULT_ORGAN_LIMITS, session: breakdownTurn },
  })
  const breakingDown = (how: string) =>
    Effect.gen(function* () {
      yield* record(log, {
        kind: 'info',
        text: `spec: breaking ${spec.path} down (${how})`,
      })
      const end = yield* steps.during('breakdown')(
        runBreakdown({
          runtime,
          graph,
          spec,
          state,
          checkout: config.checkout,
          cores: config.cores,
          concurrent: project.concurrent,
          log,
          root,
        }),
      )
      yield* BreakdownEnd.$match(end, {
        Filed: ({ root: epic }) =>
          Effect.andThen(
            record(log, {
              kind: 'info',
              text: `spec: epic ${epic}, broken down from ${spec.path}`,
            }),
            Effect.andThen(Ref.set(going, false), woken),
          ),
        NotFiled: ({ reason }) => stop(reason),
      })
    }).pipe(Effect.provideService(Git, git))
  return {
    root: Ref.get(root),
    going: Ref.get(going),
    run: SpecState.$match(state, {
      Unchanged: ({ root: epic, closed }) =>
        record(log, {
          kind: 'info',
          text: closed
            ? `spec: ${spec.path} is built (${epic})`
            : `spec: ${spec.path} unchanged: carrying on under ${epic}`,
        }),
      New: () => breakingDown('from the start'),
      Unfinished: () => breakingDown('carried on'),
      Changed: () => breakingDown('an update'),
    }),
  } satisfies SpecMode
})
