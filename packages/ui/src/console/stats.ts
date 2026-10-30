import {
  Array,
  type DateTime,
  Effect,
  Match,
  Number,
  Option,
  Schema,
} from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import { clientErrorWords } from '@fabrica/client'
import {
  type AttentionRequest,
  type Banner,
  type EngineStep,
  type Hold,
  type NoRun,
  Preflight,
  PreflightCheck,
  PreflightChoices,
  type PreflightItem,
  type ProjectNotFound,
  type RunFlags,
  type RunGoing,
  RunMode,
  type RunRefused,
  type RunState,
  type RunView,
  type StepKind,
  Text,
  TicketId,
  type Tokens,
} from '@fabrica/contracts'

import { sayElapsed, sayMoment, secondsSince } from '../app/clock'
import { EngineProject, sameProject } from '../app/engine-project'
import {
  type EngineNotConnected,
  type EngineServices,
  sessionFor,
} from '../app/engine-route'
import { waitingWords } from './waiting'

// The console's stats row (spec §18.3, H80, H81; Appendix A.2), for the scoped project's run: live
// workers against the slots, done today, set aside, needs you, in queue with how many of them wait
// (each with why in words on hover), and tokens; at its right end the run's controls, Start run and
// its modes while the project is idle, Drain and Stop while its run goes, and an overnight run's tag.
// Overnight starts after its pre-flight checklist (§15.6), drawn below the row: its refusals to fix or
// override, its warnings with their fixes, the ready and question-only counts, then its questions in
// the answer talk; the fixes chosen go with the start, so a checklist cancelled changes nothing.
// Above the row, a strip of the run's holds and banners (`c2` for a hold, `c3` for a stop) with when
// each lifts, the engine's run-wide steps with their elapsed time, and a request the engine refused.
// Under All projects the row's figures are summed over every project's run going (§18.3), with no
// controls: a run is started, drained or stopped from its project's own scope.
// A Submodel: the root folds its Messages and gives it the run, the scope and the time.

/** The modes Start run offers (§13.1), in the menu's order. */
export const StartMode = Schema.Literals([
  'tickets',
  'ticket',
  'spec',
  'feature',
  'overnight',
])
export type StartMode = typeof StartMode.Type

/** The modes that need something typed first: a ticket's ID, a spec's file or URL, a feature's text. */
export const TypedMode = Schema.Literals(['ticket', 'spec', 'feature'])
export type TypedMode = typeof TypedMode.Type

/** Each mode's name in the menu. */
export const modeTitle: Record<StartMode, string> = {
  tickets: 'The current tickets',
  ticket: 'One ticket',
  spec: 'A spec',
  feature: 'A feature',
  overnight: 'Overnight',
}

const typedField: Record<TypedMode, { label: string; placeholder: string }> = {
  ticket: { label: 'Ticket', placeholder: 'fa-12' },
  spec: { label: 'Spec', placeholder: 'docs/spec.md or an https URL' },
  feature: { label: 'Feature', placeholder: 'What the feature does' },
}

/** What the run's controls show. */
export const Controls = defineTaggedUnion({
  /** The controls alone. */
  Closed: {},
  /** Start run's modes listed. */
  ChoosingMode: {},
  /** A mode's ticket, spec or feature being typed. */
  Typing: { mode: TypedMode, text: Schema.String, refine: Schema.Boolean },
  /** Stop asked for: one more click stops the run. */
  ConfirmingStop: {},
})
export type Controls = typeof Controls.Type

/** What the controls ask of the engine. */
export const RunAction = Schema.Literals(['start', 'drain', 'undrain', 'stop'])
export type RunAction = typeof RunAction.Type

/** The controls' last request: none, one the engine hasn't answered, or one it refused, with why. */
export const Request = defineTaggedUnion({
  None: {},
  Pending: { action: RunAction },
  Refused: { action: RunAction, reason: Schema.String },
})
export type Request = typeof Request.Type

/** A pre-flight gone through so far: the fixes chosen to make, and the refusals overridden. */
const Choices = {
  project: EngineProject,
  preflight: Preflight,
  fix: Schema.Array(PreflightCheck),
  override: Schema.Array(PreflightCheck),
}

/** An overnight run's pre-flight checklist (§15.6). */
export const Checklist = defineTaggedUnion({
  /** None open. */
  None: {},
  /** The engine asked for the pre-flight. */
  Checking: { project: EngineProject },
  /** The engine couldn't give it, with why. */
  Failed: { project: EngineProject, reason: Schema.String },
  /** Its refusals and warnings shown, each fix and override chosen. */
  Reviewing: Choices,
  /** Its questions being answered in the answer talk. */
  Answering: Choices,
})
export type Checklist = typeof Checklist.Type

export const Model = Schema.Struct({
  controls: Controls,
  request: Request,
  checklist: Checklist,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  controls: Controls.Closed(),
  request: Request.None(),
  checklist: Checklist.None(),
})

export const Message = defineMessageUnion({
  ClickedStartRun: {},
  ChoseMode: { project: EngineProject, mode: StartMode },
  TypedModeText: { text: Schema.String },
  ToggledRefine: {},
  SubmittedMode: { project: EngineProject },
  CancelledControls: {},
  ClickedDrain: { project: EngineProject },
  ClickedUndrain: { project: EngineProject },
  ClickedStop: {},
  ConfirmedStop: { project: EngineProject },
  SucceededStartRun: { project: EngineProject },
  SucceededRunRequest: {},
  FailedRunRequest: { action: RunAction, reason: Schema.String },
  DismissedRefusal: {},
  SucceededPreflight: { project: EngineProject, preflight: Preflight },
  FailedPreflight: { project: EngineProject, reason: Schema.String },
  ToggledFix: { check: PreflightCheck },
  ToggledOverride: { check: PreflightCheck },
  ClickedCheckAgain: {},
  /** On from the refusals and warnings: to the questions, or the start where there are none. */
  ClickedContinue: {},
  ClickedStartOvernight: {},
  CancelledChecklist: {},
})
export type Message = typeof Message.Type

/**
 * What the root does on the controls' behalf: a started run's view is watched afresh, and the answer
 * talk opened on a pre-flight's questions.
 */
export const OutMessage = defineMessageUnion({
  StartedRun: { project: EngineProject },
  AnsweringQuestions: { project: EngineProject },
})
export type OutMessage = typeof OutMessage.Type

/** What the controls are given: the scope, the connection and the scoped project's run. */
export interface ControlInputs {
  /** The project the sidebar chose: its run's controls are the row's. */
  readonly project: Option.Option<EngineProject>
  /** Whether the engine's client is held, so requests can be sent. */
  readonly live: boolean
  /** The scoped project's run view, while it has a run. */
  readonly run: Option.Option<RunView>
}

/** The project the controls act on: the scoped one, while the engine's client is held. */
export const controlledProject = (
  inputs: ControlInputs,
): Option.Option<EngineProject> =>
  inputs.live ? inputs.project : Option.none()

/** Whether the run's controls wait: a request unanswered, or the run stopping. */
export const isBusy = (model: Model, state: RunState): boolean =>
  Request.guards.Pending(model.request) || state === 'stopping'

/**
 * A control the row offers now, enabled: the console's keys and the palette run the same ones
 * (§13.10, §18.5), so a key acts only where its button would.
 */
export const Offer = defineTaggedUnion({
  /** Start run, which opens its modes. */
  Start: { project: EngineProject },
  /** One of Start run's modes, chosen straight away. */
  StartIn: { project: EngineProject, mode: StartMode },
  /** Start run's modes or a mode's field closed. */
  CloseStart: {},
  Drain: { project: EngineProject },
  Undrain: { project: EngineProject },
  /** Stop, which asks its confirmation first. */
  Stop: {},
  ConfirmStop: { project: EngineProject },
  KeepRunning: {},
})
export type Offer = typeof Offer.Type

/** The controls the row offers enabled, in its order: none without a project or a connection. */
export const offers = (
  model: Model,
  inputs: ControlInputs,
): ReadonlyArray<Offer> =>
  Option.match(controlledProject(inputs), {
    onNone: () => [],
    onSome: project =>
      Option.match(inputs.run, {
        onNone: () =>
          Controls.guards.Typing(model.controls)
            ? [Offer.CloseStart()]
            : Request.guards.Pending(model.request)
              ? []
              : [
                  Offer.Start({ project }),
                  ...StartMode.literals.map(mode =>
                    Offer.StartIn({ project, mode }),
                  ),
                  ...(Controls.guards.ChoosingMode(model.controls)
                    ? [Offer.CloseStart()]
                    : []),
                ],
        onSome: run =>
          isBusy(model, run.header.state)
            ? []
            : [
                run.header.state === 'draining'
                  ? Offer.Undrain({ project })
                  : Offer.Drain({ project }),
                ...(Controls.guards.ConfirmingStop(model.controls)
                  ? [Offer.ConfirmStop({ project }), Offer.KeepRunning()]
                  : [Offer.Stop()]),
              ],
      }),
  })

/** What an offered control is called, as its button says it. */
export const offerTitle = (offer: Offer): string =>
  Offer.match(offer, {
    Start: () => 'Start run',
    StartIn: ({ mode }) => `Start run: ${modeTitle[mode]}`,
    CloseStart: () => 'Cancel Start run',
    Drain: () => 'Drain',
    Undrain: () => 'Undrain',
    Stop: () => 'Stop',
    ConfirmStop: () => 'Stop the run',
    KeepRunning: () => 'Keep running',
  })

/** The Message an offered control's button sends. */
export const offerMessage = (offer: Offer): Message =>
  Offer.match(offer, {
    Start: () => Message.ClickedStartRun(),
    StartIn: ({ project, mode }) => Message.ChoseMode({ project, mode }),
    CloseStart: () => Message.CancelledControls(),
    Drain: ({ project }) => Message.ClickedDrain({ project }),
    Undrain: ({ project }) => Message.ClickedUndrain({ project }),
    Stop: () => Message.ClickedStop(),
    ConfirmStop: ({ project }) => Message.ConfirmedStop({ project }),
    KeepRunning: () => Message.CancelledControls(),
  })

/** A run started from the app: no dispatch limit, online, the project's own settings, no pre-flight. */
export const startFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  preflight: Option.none(),
}

/** What a run request can fail with: the engine's refusals, its engine not connected, or the connection lost. */
export type RunRequestError =
  | ProjectNotFound
  | RunGoing
  | RunRefused
  | NoRun
  | EngineNotConnected
  | RpcClientError.RpcClientError

/** Why the engine refused a request, in words. */
export const refusalWords = (error: RunRequestError): string =>
  Match.valueTags(error, {
    RunRefused: ({ problems }) => problems.join('; '),
    RunGoing: () => 'the project has a run going already',
    NoRun: () => 'the project has no run going',
    ProjectNotFound: () => "the engine doesn't know the project",
    EngineNotConnected: () => 'not connected to the engine',
    RpcClientError: clientErrorWords,
  })

const startRun = (project: EngineProject, mode: RunMode, flags: RunFlags) =>
  sessionFor(project).pipe(
    Effect.flatMap(({ client }) =>
      client.rpc['run.start']({ project: project.project, mode, flags }),
    ),
    Effect.as(Message.SucceededStartRun({ project })),
    Effect.catch(error =>
      Effect.succeed(
        Message.FailedRunRequest({
          action: 'start',
          reason: refusalWords(error),
        }),
      ),
    ),
  )

/** Starts a run of `project` in `mode`. */
export const StartRun = Command.define('StartRun', {
  args: { project: EngineProject, mode: RunMode },
  messages: [Message.SucceededStartRun, Message.FailedRunRequest],
  execute: ({ project, mode }) => startRun(project, mode, startFlags),
})

/** Asks the engine for `project`'s overnight pre-flight (§15.6), with the flags the start will have. */
export const CheckPreflight = Command.define('CheckPreflight', {
  args: { project: EngineProject },
  messages: [Message.SucceededPreflight, Message.FailedPreflight],
  execute: ({ project }) =>
    sessionFor(project).pipe(
      Effect.flatMap(({ client }) =>
        client.rpc['run.preflight']({
          project: project.project,
          mode: RunMode.cases.overnight.make({}),
          flags: startFlags,
        }),
      ),
      Effect.map(preflight =>
        Message.SucceededPreflight({ project, preflight }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedPreflight({ project, reason: refusalWords(error) }),
        ),
      ),
    ),
})

/** An overnight run's flags: the app's, with what its pre-flight chose. */
export const overnightFlags = (
  fix: ReadonlyArray<PreflightCheck>,
  override: ReadonlyArray<PreflightCheck>,
): RunFlags => ({
  ...startFlags,
  preflight: Option.some(new PreflightChoices({ fix, override })),
})

/** Starts `project`'s overnight run, its pre-flight's chosen fixes made and its refusals overridden. */
export const StartOvernight = Command.define('StartOvernight', {
  args: {
    project: EngineProject,
    fix: Schema.Array(PreflightCheck),
    override: Schema.Array(PreflightCheck),
  },
  messages: [Message.SucceededStartRun, Message.FailedRunRequest],
  execute: ({ project, fix, override }) =>
    startRun(
      project,
      RunMode.cases.overnight.make({}),
      overnightFlags(fix, override),
    ),
})

/** Drains, undrains or stops `project`'s run. */
export const AskRun = Command.define('AskRun', {
  args: {
    project: EngineProject,
    action: Schema.Literals(['drain', 'undrain', 'stop']),
  },
  messages: [Message.SucceededRunRequest, Message.FailedRunRequest],
  execute: ({ project, action }) =>
    sessionFor(project).pipe(
      Effect.flatMap(({ client }) =>
        action === 'drain'
          ? client.rpc['run.drain']({ project: project.project })
          : action === 'undrain'
            ? client.rpc['run.undrain']({ project: project.project })
            : client.rpc['run.stop']({ project: project.project }),
      ),
      Effect.as(Message.SucceededRunRequest()),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRunRequest({ action, reason: refusalWords(error) }),
        ),
      ),
    ),
})

type Return = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  EngineServices
>

const decodeTicket = Schema.decodeUnknownOption(TicketId)
const decodeText = Schema.decodeUnknownOption(Text)

/** The run mode the typed text makes, if it makes one: a ticket's ID must be one. */
export const typedMode = (
  mode: TypedMode,
  text: string,
  refine: boolean,
): Option.Option<RunMode> => {
  const typed = text.trim()
  return mode === 'ticket'
    ? Option.map(decodeTicket(typed), ticket =>
        RunMode.cases.ticket.make({ ticket }),
      )
    : mode === 'spec'
      ? Option.map(decodeText(typed), source =>
          RunMode.cases.spec.make({ source, refine }),
        )
      : Option.map(decodeText(typed), text =>
          RunMode.cases.feature.make({ text }),
        )
}

const starting = (
  model: Model,
  project: EngineProject,
  mode: RunMode,
): Return => ({
  model: modifyFields(model, {
    controls: () => Controls.Closed(),
    request: () => Request.Pending({ action: 'start' }),
    checklist: () => Checklist.None(),
  }),
  commands: [StartRun({ project, mode })],
})

// The pre-flight checklist.

type Gone = Extract<Checklist, { readonly _tag: 'Reviewing' | 'Answering' }>

/** The checklist's project, while one is open. */
const checklistProject = (checklist: Checklist): Option.Option<EngineProject> =>
  Checklist.match(checklist, {
    None: () => Option.none(),
    Checking: ({ project }) => Option.some(project),
    Failed: ({ project }) => Option.some(project),
    Reviewing: ({ project }) => Option.some(project),
    Answering: ({ project }) => Option.some(project),
  })

/** A pre-flight first shown: every fix it offers chosen, no refusal overridden. */
export const offered = (
  project: EngineProject,
  preflight: Preflight,
): Extract<Checklist, { readonly _tag: 'Reviewing' }> =>
  Checklist.Reviewing({
    project,
    preflight,
    fix: [...preflight.refusals, ...preflight.warnings]
      .filter(item => Option.isSome(item.fix))
      .map(item => item.check),
    override: [],
  })

/** The refusals neither fixed nor overridden, which keep the run from starting. */
export const standing = (gone: Gone): ReadonlyArray<PreflightItem> =>
  gone.preflight.refusals.filter(
    ({ check, fix }) =>
      !gone.override.includes(check) &&
      !(Option.isSome(fix) && gone.fix.includes(check)),
  )

const toggle = (
  checks: ReadonlyArray<PreflightCheck>,
  check: PreflightCheck,
): ReadonlyArray<PreflightCheck> =>
  checks.includes(check)
    ? checks.filter(chosen => chosen !== check)
    : [...checks, check]

/** The checklist under review changed by `change`; any other left as it is. */
const reviewing = (
  model: Model,
  change: (
    gone: Extract<Checklist, { readonly _tag: 'Reviewing' }>,
  ) => Checklist,
): Return => ({
  model: modifyFields(model, {
    checklist: checklist =>
      Checklist.guards.Reviewing(checklist) ? change(checklist) : checklist,
  }),
})

const checking = (model: Model, project: EngineProject): Return => ({
  model: modifyFields(model, {
    controls: () => Controls.Closed(),
    checklist: () => Checklist.Checking({ project }),
  }),
  commands: [CheckPreflight({ project })],
})

/** The overnight run started with the checklist's choices, the checklist closed. */
const startingOvernight = (model: Model, gone: Gone): Return => ({
  model: modifyFields(model, {
    request: () => Request.Pending({ action: 'start' }),
    checklist: () => Checklist.None(),
  }),
  commands: [
    StartOvernight({
      project: gone.project,
      fix: gone.fix,
      override: gone.override,
    }),
  ],
})

const asking = (
  model: Model,
  project: EngineProject,
  action: 'drain' | 'undrain' | 'stop',
): Return => ({
  model: modifyFields(model, {
    controls: () => Controls.Closed(),
    request: () => Request.Pending({ action }),
  }),
  commands: [AskRun({ project, action })],
})

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedStartRun: () => ({
      model: modifyFields(model, {
        controls: controls =>
          Controls.guards.ChoosingMode(controls)
            ? Controls.Closed()
            : Controls.ChoosingMode(),
      }),
    }),
    ChoseMode: ({ project, mode }) =>
      mode === 'tickets'
        ? starting(model, project, RunMode.cases.tickets.make({}))
        : mode === 'overnight'
          ? checking(model, project)
          : {
              model: modifyFields(model, {
                controls: () =>
                  Controls.Typing({ mode, text: '', refine: false }),
              }),
            },
    TypedModeText: ({ text }) => ({
      model: modifyFields(model, {
        controls: controls =>
          Controls.guards.Typing(controls)
            ? Controls.Typing({ ...controls, text })
            : controls,
      }),
    }),
    ToggledRefine: () => ({
      model: modifyFields(model, {
        controls: controls =>
          Controls.guards.Typing(controls)
            ? Controls.Typing({ ...controls, refine: !controls.refine })
            : controls,
      }),
    }),
    SubmittedMode: ({ project }) =>
      Controls.guards.Typing(model.controls)
        ? Option.match(
            typedMode(
              model.controls.mode,
              model.controls.text,
              model.controls.refine,
            ),
            {
              onNone: () => ({ model }),
              onSome: mode => starting(model, project, mode),
            },
          )
        : { model },
    CancelledControls: () => ({
      model: modifyFields(model, { controls: () => Controls.Closed() }),
    }),
    ClickedDrain: ({ project }) => asking(model, project, 'drain'),
    ClickedUndrain: ({ project }) => asking(model, project, 'undrain'),
    ClickedStop: () => ({
      model: modifyFields(model, {
        controls: () => Controls.ConfirmingStop(),
      }),
    }),
    ConfirmedStop: ({ project }) => asking(model, project, 'stop'),
    SucceededStartRun: ({ project }) => ({
      model: modifyFields(model, { request: () => Request.None() }),
      outMessage: OutMessage.StartedRun({ project }),
    }),
    SucceededRunRequest: () => ({
      model: modifyFields(model, { request: () => Request.None() }),
    }),
    FailedRunRequest: ({ action, reason }) => ({
      model: modifyFields(model, {
        request: () => Request.Refused({ action, reason }),
      }),
    }),
    DismissedRefusal: () => ({
      model: modifyFields(model, { request: () => Request.None() }),
    }),
    SucceededPreflight: ({ project, preflight }) => ({
      model: modifyFields(model, {
        checklist: checklist =>
          Checklist.guards.Checking(checklist) &&
          sameProject(checklist.project, project)
            ? offered(project, preflight)
            : checklist,
      }),
    }),
    FailedPreflight: ({ project, reason }) => ({
      model: modifyFields(model, {
        checklist: checklist =>
          Checklist.guards.Checking(checklist) &&
          sameProject(checklist.project, project)
            ? Checklist.Failed({ project, reason })
            : checklist,
      }),
    }),
    // A refusal is fixed or overridden, never both.
    ToggledFix: ({ check }) =>
      reviewing(model, gone =>
        Checklist.Reviewing({
          ...gone,
          fix: toggle(gone.fix, check),
          override: gone.override.filter(chosen => chosen !== check),
        }),
      ),
    ToggledOverride: ({ check }) =>
      reviewing(model, gone =>
        Checklist.Reviewing({
          ...gone,
          override: toggle(gone.override, check),
          fix: gone.fix.filter(chosen => chosen !== check),
        }),
      ),
    ClickedCheckAgain: () =>
      Option.match(checklistProject(model.checklist), {
        onNone: () => ({ model }),
        onSome: project => checking(model, project),
      }),
    ClickedContinue: () => {
      const { checklist } = model
      if (
        !Checklist.guards.Reviewing(checklist) ||
        standing(checklist).length > 0
      ) {
        return { model }
      }
      return checklist.preflight.questions.length === 0
        ? startingOvernight(model, checklist)
        : {
            model: modifyFields(model, {
              checklist: () =>
                Checklist.Answering({
                  project: checklist.project,
                  preflight: checklist.preflight,
                  fix: checklist.fix,
                  override: checklist.override,
                }),
            }),
            outMessage: OutMessage.AnsweringQuestions({
              project: checklist.project,
            }),
          }
    },
    ClickedStartOvernight: () =>
      Checklist.guards.Answering(model.checklist)
        ? startingOvernight(model, model.checklist)
        : { model },
    CancelledChecklist: () => ({
      model: modifyFields(model, { checklist: () => Checklist.None() }),
    }),
  })

// The figures.

/** All of a run's tokens, its cache's included. */
export const tokenTotal = (tokens: Tokens): number =>
  tokens.input + tokens.output + tokens.cache_write + tokens.cache_read

/** A count of tokens as the handoff writes it: `512`, `34k`, `1.2M`. */
export const sayTokens = (count: number): string =>
  count >= 1_000_000
    ? `${trimTenths(count / 1_000_000)}M`
    : count >= 1_000
      ? `${trimTenths(count / 1_000)}k`
      : String(count)

/** One decimal under 10 (`1.2`), none from there (`34`), and none where it is 0 (`2`). */
const trimTenths = (value: number): string =>
  value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)

/** A ticket in the queue that waits for more than a slot, and why, in words (H81). */
export interface Waiting {
  readonly ticket: TicketId
  readonly why: string
}

/** The run's waiting tickets, in the view's order, each with why. */
export const waitingOf = (run: RunView): ReadonlyArray<Waiting> =>
  Array.getSomes(
    run.tickets.map(row =>
      Option.map(waitingWords(row.phase), why => ({ ticket: row.ticket, why })),
    ),
  )

/** The row's figures: one run's, or summed over the runs of the scope. */
export interface Figures {
  readonly live: number
  readonly slots: number
  readonly doneToday: number
  readonly setAside: number
  readonly needsYou: number
  readonly inQueue: number
  /** All the runs' tokens, their caches' included. */
  readonly tokens: number
  /** The waiting tickets, run after run, each run's in its view's order. */
  readonly waiting: ReadonlyArray<Waiting>
}

/** The figures of `runs`, each summed over them. */
export const figuresOf = (runs: ReadonlyArray<RunView>): Figures => {
  const sum = (of: (run: RunView) => number): number =>
    Number.sumAll(runs.map(of))
  return {
    live: sum(run => run.totals.live),
    slots: sum(run => run.totals.slots),
    doneToday: sum(run => run.totals.doneToday),
    setAside: sum(run => run.totals.counts.set_aside),
    needsYou: sum(run => run.totals.counts.needs_you),
    inQueue: sum(run => run.totals.counts.in_queue),
    tokens: sum(run => tokenTotal(run.totals.tokens)),
    waiting: runs.flatMap(waitingOf),
  }
}

// The strip above the row.

/** A notice's tone: its colour and the word said beside it, never the colour alone (§18.2). */
export type Tone = 'hold' | 'stop' | 'warning'

const toneWord: Record<Tone, string> = {
  hold: 'Hold',
  stop: 'Stop',
  warning: 'Warning',
}

const toneColour: Record<Tone, string> = {
  hold: 'text-c2',
  stop: 'text-c3',
  warning: 'text-c2',
}

/** A hold's tone: the run winding down to stop is a stop, every other hold a hold. */
export const holdTone = (hold: Hold): Tone =>
  hold.kind === 'STOP' ? 'stop' : 'hold'

/** What a run-wide engine step is doing, in words. */
export const stepWords: Record<StepKind, string> = {
  start_checks: 'Running the start checks',
  backlog: 'Reading the backlog',
  carry_over: 'Carrying over the last run',
  setup: 'Setting up',
  merge_check: 'Running the merge check',
  full_check_setup: 'Setting up the full check',
  full_check: 'Running the full check',
  report: 'Writing the run report',
  install: 'Installing the requirements',
  breakdown: 'Breaking down the spec',
}

/**
 * The steps the strip times: the run's own, past their first second (H80). A ticket's step (its setup,
 * its merge check) shows in its card instead.
 */
export const shownSteps = (
  steps: ReadonlyArray<EngineStep>,
  now: DateTime.DateTime,
): ReadonlyArray<EngineStep> =>
  steps.filter(
    step =>
      Option.isNone(step.ticket) && secondsSince(step.startedAt, now) >= 1,
  )

/** A pre-flight's question still open, with its title and the tickets it holds, where they are read. */
export interface QuestionLeft {
  readonly ticket: TicketId
  readonly title: Option.Option<string>
  readonly holds: ReadonlyArray<TicketId>
}

/**
 * The pre-flight's questions still open, by the scope's attention requests: one no longer among them is
 * answered; every one is open while they aren't read yet.
 */
export const questionsLeft = (
  gone: Gone,
  attention: Option.Option<ReadonlyArray<AttentionRequest>>,
): ReadonlyArray<QuestionLeft> =>
  Option.match(attention, {
    onNone: () =>
      gone.preflight.questions.map(ticket => ({
        ticket,
        title: Option.none(),
        holds: [],
      })),
    onSome: requests => {
      const open = requests.flatMap(request =>
        request._tag === 'question' && request.project === gone.project.project
          ? [request]
          : [],
      )
      return Array.getSomes(
        gone.preflight.questions.map(ticket =>
          Option.map(
            Array.findFirst(open, request => request.ticket === ticket),
            request => ({
              ticket,
              title: Option.some(request.title),
              holds: request.blocks,
            }),
          ),
        ),
      )
    },
  })

/** What the frame gives the row: what its controls are given, every project's runs, and the time. */
export interface ViewInputs extends ControlInputs {
  /** Under All projects, every project's run going, whose figures the row sums; none in a project's scope. */
  readonly runs: ReadonlyArray<RunView>
  /** The time now, in the viewer's zone. */
  readonly now: Option.Option<DateTime.Zoned>
  /** The scope's open attention requests, whose questions the pre-flight waits on. */
  readonly attention: Option.Option<ReadonlyArray<AttentionRequest>>
}

const toneMark = (tone: Tone, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('tone-mark', tone),
      h.Class(`font-extrabold ${toneColour[tone]}`),
    ],
    [toneWord[tone]],
  )

const lifting = (
  lifts: Option.Option<DateTime.Utc>,
  now: Option.Option<DateTime.Zoned>,
): ReadonlyArray<string> =>
  Option.match(Option.all({ lifts, now }), {
    onNone: () => [],
    onSome: ({ lifts, now }) => [`lifts ${sayMoment(lifts, now)}`],
  })

const notice = (
  {
    key,
    tone,
    text,
    after,
  }: {
    readonly key: string
    readonly tone: Tone
    readonly text: string
    readonly after: ReadonlyArray<Html | string>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    key,
    [
      h.DataAttribute('tone', tone),
      h.Class(
        `flex items-baseline gap-8 rounded-card border border-line bg-panel px-12 py-6 text-xs ${tone === 'stop' ? 'border-c3' : 'border-c2'}`,
      ),
    ],
    [toneMark(tone, h), h.span([h.Class('text-fg')], [text]), ...after],
  )

const holdNotice = (
  hold: Hold,
  index: number,
  now: Option.Option<DateTime.Zoned>,
  h: HtmlBuilder<Message>,
): Html =>
  notice(
    {
      key: `hold-${hold.kind}-${index}`,
      tone: holdTone(hold),
      text: hold.reason,
      after: lifting(hold.lifts, now).map(words =>
        h.span([h.DataAttribute('lifts', ''), h.Class('text-muted')], [words]),
      ),
    },
    h,
  )

const bannerNotice = (
  banner: Banner,
  index: number,
  now: Option.Option<DateTime.Zoned>,
  h: HtmlBuilder<Message>,
): Html =>
  notice(
    {
      key: `banner-${index}`,
      tone: banner.tone,
      text: banner.text,
      after: lifting(banner.lifts, now).map(words =>
        h.span([h.DataAttribute('lifts', ''), h.Class('text-muted')], [words]),
      ),
    },
    h,
  )

const stepNotice = (
  step: EngineStep,
  now: DateTime.Zoned,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    `step-${step.step}`,
    [
      h.DataAttribute('step', step.step),
      h.Class(
        'flex items-baseline gap-8 rounded-card border border-line bg-panel px-12 py-6 text-xs',
      ),
    ],
    [
      h.span([h.Class('font-extrabold text-c5')], ['Engine']),
      h.span([h.Class('text-fg')], [`${stepWords[step.step]}…`]),
      h.span(
        [
          h.DataAttribute('elapsed', ''),
          h.Class('ml-auto font-mono text-muted'),
        ],
        [sayElapsed(step.startedAt, now)],
      ),
    ],
  )

const actionTitle: Record<RunAction, string> = {
  start: 'Start run',
  drain: 'Drain',
  undrain: 'Undrain',
  stop: 'Stop',
}

const refusalNotice = (request: Request, h: HtmlBuilder<Message>): Html =>
  Request.guards.Refused(request)
    ? h.keyed('li')(
        'refusal',
        [
          h.DataAttribute('tone', 'stop' satisfies Tone),
          h.Class(
            'flex items-baseline gap-8 rounded-card border border-c3 bg-panel px-12 py-6 text-xs',
          ),
        ],
        [
          toneMark('stop', h),
          h.span(
            [h.Class('text-fg')],
            [`${actionTitle[request.action]} refused: ${request.reason}`],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.DismissedRefusal()),
              h.Class('ml-auto text-muted'),
            ],
            ['Dismiss'],
          ),
        ],
      )
    : h.empty

/** The strip: the run's holds, its banners, its run-wide steps and a refused request; nothing when none. */
const strip = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const holds = Option.match(inputs.run, {
    onNone: () => [],
    onSome: run =>
      run.holds.map((hold, index) => holdNotice(hold, index, inputs.now, h)),
  })
  const banners = Option.match(inputs.run, {
    onNone: () => [],
    onSome: run =>
      run.banners.map((banner, index) =>
        bannerNotice(banner, index, inputs.now, h),
      ),
  })
  const steps = Option.match(Option.all({ run: inputs.run, now: inputs.now }), {
    onNone: () => [],
    onSome: ({ run, now }) =>
      shownSteps(run.steps, now).map(step => stepNotice(step, now, h)),
  })
  const items = [
    ...holds,
    ...banners,
    ...steps,
    ...(Request.guards.Refused(model.request)
      ? [refusalNotice(model.request, h)]
      : []),
  ]
  return items.length === 0
    ? h.empty
    : h.ul(
        [h.AriaLabel('Holds and banners'), h.Class('flex flex-col gap-6')],
        items,
      )
}

// The row.

/** A stat's colour, its role's (§18.2). */
type Role = 'c1' | 'c2' | 'c3' | 'c4' | 'c5'

const roleText: Record<Role, string> = {
  c1: 'text-c1',
  c2: 'text-c2',
  c3: 'text-c3',
  c4: 'text-c4',
  c5: 'text-c5',
}

const item = (
  {
    name,
    value,
    label,
    role,
    after = [],
    hover = Option.none(),
  }: {
    readonly name: string
    readonly value: string
    readonly label: string
    readonly role: Role
    readonly after?: ReadonlyArray<Html>
    readonly hover?: Option.Option<string>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel(`${label} ${value}`),
      h.DataAttribute('stat', name),
      h.Class('flex items-baseline gap-8 border-r border-line'),
      h.Style({ padding: '10px 18px' }),
      ...Option.match(hover, {
        onNone: () => [],
        onSome: words => [h.Title(words)],
      }),
    ],
    [
      h.span(
        [
          h.DataAttribute('value', ''),
          h.Class(`leading-none font-extrabold ${roleText[role]}`),
          h.Style({ fontSize: '20px' }),
        ],
        [value],
      ),
      h.span(
        [h.Class('text-xs font-bold whitespace-nowrap text-muted')],
        [label],
      ),
      ...after,
    ],
  )

const figures = (
  shown: Figures,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { waiting } = shown
  return [
    item(
      {
        name: 'live',
        value: `${shown.live} of ${shown.slots}`,
        label: 'Workers live',
        role: 'c1',
      },
      h,
    ),
    item(
      {
        name: 'done',
        value: String(shown.doneToday),
        label: 'Done today',
        role: 'c4',
      },
      h,
    ),
    item(
      {
        name: 'set-aside',
        value: String(shown.setAside),
        label: 'Set aside',
        role: 'c3',
      },
      h,
    ),
    item(
      {
        name: 'needs-you',
        value: String(shown.needsYou),
        label: 'Needs you',
        role: 'c2',
      },
      h,
    ),
    item(
      {
        name: 'in-queue',
        value: String(shown.inQueue),
        label: 'In queue',
        role: 'c5',
        after:
          waiting.length === 0
            ? []
            : [
                h.span(
                  [
                    h.DataAttribute('waiting', ''),
                    h.Class('text-xs text-muted'),
                  ],
                  [`${waiting.length} waiting`],
                ),
              ],
        hover:
          waiting.length === 0
            ? Option.none()
            : Option.some(
                waiting
                  .map(({ ticket, why }) => `${ticket}: ${why}`)
                  .join('\n'),
              ),
      },
      h,
    ),
    item(
      {
        name: 'tokens',
        value: sayTokens(shown.tokens),
        label: 'Tokens',
        role: 'c5',
      },
      h,
    ),
  ]
}

const primaryLook =
  'rounded-button bg-c1 font-bold text-ink shadow-glow1 hover:brightness-[1.08] disabled:opacity-60'
const ghostLook =
  'rounded-button border border-line text-fg hover:brightness-[1.08] disabled:opacity-60'
const primaryButton = `${primaryLook} px-12 py-6 text-sm`
const ghostButton = `${ghostLook} px-12 py-6 text-sm`
// The row's own controls are smaller, so that they keep to the handoff's 44px strip, on one line
// beside its six items in every theme (Neon Grid's monospace the widest).
const rowPrimaryButton = `${primaryLook} px-8 py-4 text-xs`
const rowGhostButton = `${ghostLook} px-8 py-4 text-xs`

const modeMenu = (project: EngineProject, h: HtmlBuilder<Message>): Html =>
  h.ul(
    [
      h.Role('menu'),
      h.AriaLabel('Start run'),
      h.Class(
        'absolute right-0 top-full z-10 mt-4 flex flex-col rounded-card border border-line bg-panel py-4 shadow-glow1',
      ),
      h.Style({ minWidth: '200px' }),
    ],
    StartMode.literals.map((mode, index) =>
      h.keyed('li')(
        mode,
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.Role('menuitem'),
              // Opened by its key, the menu takes focus: Tab and Enter choose a mode (§18.5).
              h.Autofocus(index === 0),
              h.OnClick(Message.ChoseMode({ project, mode })),
              h.Class('w-full px-12 py-4 text-left text-sm hover:bg-bg'),
            ],
            [modeTitle[mode]],
          ),
        ],
      ),
    ),
  )

const typingForm = (
  project: EngineProject,
  typing: Extract<Controls, { readonly _tag: 'Typing' }>,
  h: HtmlBuilder<Message>,
): Html => {
  const field = typedField[typing.mode]
  const ready = Option.isSome(
    typedMode(typing.mode, typing.text, typing.refine),
  )
  return h.form(
    [
      h.AriaLabel(`Start run: ${modeTitle[typing.mode]}`),
      h.OnSubmit(Message.SubmittedMode({ project })),
      h.Class('flex items-center gap-8'),
    ],
    [
      h.input([
        h.Type('text'),
        h.AriaLabel(field.label),
        h.Placeholder(field.placeholder),
        h.Value(typing.text),
        h.Autofocus(true),
        h.OnInput(text => Message.TypedModeText({ text })),
        h.Class(
          'rounded-button border border-line bg-bg px-8 py-4 text-xs text-fg',
        ),
      ]),
      typing.mode === 'spec'
        ? h.label(
            [h.Class('flex items-center gap-4 text-xs text-muted')],
            [
              h.input([
                h.Type('checkbox'),
                h.AriaLabel('Refine first'),
                h.Checked(typing.refine),
                h.OnClick(Message.ToggledRefine()),
              ]),
              'Refine first',
            ],
          )
        : h.empty,
      h.button(
        [h.Type('submit'), h.Disabled(!ready), h.Class(rowPrimaryButton)],
        ['Start'],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.CancelledControls()),
          h.Class(rowGhostButton),
        ],
        ['Cancel'],
      ),
    ],
  )
}

/** Start run, its modes or a mode's field: the project is idle. */
const idleControls = (
  model: Model,
  project: EngineProject,
  h: HtmlBuilder<Message>,
): Html =>
  Controls.guards.Typing(model.controls)
    ? typingForm(project, model.controls, h)
    : h.div(
        [h.Class('relative')],
        [
          h.button(
            [
              h.Type('button'),
              h.AriaHasPopup('menu'),
              h.AriaExpanded(Controls.guards.ChoosingMode(model.controls)),
              h.Disabled(Request.guards.Pending(model.request)),
              h.OnClick(Message.ClickedStartRun()),
              h.Class(rowPrimaryButton),
            ],
            [Request.guards.Pending(model.request) ? 'Starting…' : 'Start run'],
          ),
          Controls.guards.ChoosingMode(model.controls)
            ? modeMenu(project, h)
            : h.empty,
        ],
      )

const stateWords: Record<RunState, Option.Option<string>> = {
  starting: Option.some('Starting…'),
  running: Option.none(),
  draining: Option.some('Draining'),
  stopping: Option.some('Stopping…'),
}

/** Drain (or Undrain) and Stop: the project's run goes. */
const runningControls = (
  model: Model,
  project: EngineProject,
  state: RunState,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const busy = isBusy(model, state)
  return [
    Option.match(stateWords[state], {
      onNone: () => h.empty,
      onSome: words =>
        h.span(
          [
            h.DataAttribute('run-state', state),
            h.Class('text-xs font-bold text-muted'),
          ],
          [words],
        ),
    }),
    state === 'draining'
      ? h.button(
          [
            h.Type('button'),
            h.Disabled(busy),
            h.OnClick(Message.ClickedUndrain({ project })),
            h.Class(rowGhostButton),
          ],
          ['Undrain'],
        )
      : h.button(
          [
            h.Type('button'),
            h.Disabled(busy),
            h.OnClick(Message.ClickedDrain({ project })),
            h.Class(rowGhostButton),
          ],
          ['Drain'],
        ),
    ...(Controls.guards.ConfirmingStop(model.controls)
      ? [
          h.button(
            [
              h.Type('button'),
              h.Disabled(busy),
              h.OnClick(Message.ConfirmedStop({ project })),
              h.Class(
                'rounded-button bg-c3 px-8 py-4 text-xs font-bold text-ink hover:brightness-[1.08]',
              ),
            ],
            ['Stop the run'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.CancelledControls()),
              h.Class(rowGhostButton),
            ],
            ['Keep running'],
          ),
        ]
      : [
          h.button(
            [
              h.Type('button'),
              h.Disabled(busy),
              h.OnClick(Message.ClickedStop()),
              h.Class(rowGhostButton),
            ],
            ['Stop'],
          ),
        ]),
  ]
}

const overnightTag = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('tag', 'overnight'),
      h.Class('rounded-button border border-c5 px-6 text-xs font-bold text-c5'),
    ],
    ['overnight'],
  )

/** The run's controls at the row's right end: none without a project or a connection. */
const controls = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(controlledProject(inputs), {
    onNone: () => h.empty,
    onSome: project =>
      h.div(
        [
          h.Role('group'),
          h.AriaLabel('Run controls'),
          h.Class('ml-auto flex items-center gap-6'),
          h.Style({ padding: '6px 8px' }),
        ],
        Option.match(inputs.run, {
          onNone: () => [idleControls(model, project, h)],
          onSome: run => [
            RunMode.guards.overnight(run.header.mode)
              ? overnightTag(h)
              : h.empty,
            ...runningControls(model, project, run.header.state, h),
          ],
        }),
      ),
  })

/** The runs the row's figures are of: the scoped project's, or under All projects every one going; none without. */
const scopeRuns = (
  inputs: ViewInputs,
): Option.Option<Array.NonEmptyReadonlyArray<RunView>> =>
  Option.isSome(inputs.project)
    ? Option.map(inputs.run, run => Array.of(run))
    : Array.isReadonlyArrayNonEmpty(inputs.runs)
      ? Option.some(inputs.runs)
      : Option.none()

const row = (model: Model, inputs: ViewInputs, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute('layout', 'stats-row'),
      h.Class(
        'flex flex-wrap items-center rounded-card border border-line bg-panel',
      ),
    ],
    [
      ...Option.match(scopeRuns(inputs), {
        onNone: () => [
          h.span(
            [h.Class('text-sm text-muted'), h.Style({ padding: '10px 18px' })],
            [Option.isSome(inputs.project) ? 'No run' : 'No run going'],
          ),
        ],
        onSome: runs => figures(figuresOf(runs), h),
      }),
      controls(model, inputs, h),
    ],
  )

// The pre-flight checklist below the row.

const checkbox = (
  {
    label,
    checked,
    message,
  }: {
    readonly label: string
    readonly checked: boolean
    readonly message: Message
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.Class('flex items-center gap-4 text-xs text-muted')],
    [
      h.input([
        h.Type('checkbox'),
        h.AriaLabel(label),
        h.Checked(checked),
        h.OnClick(message),
      ]),
      label,
    ],
  )

const fixBox = (
  gone: Gone,
  item: PreflightItem,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(item.fix, {
    onNone: () => h.empty,
    onSome: fix =>
      checkbox(
        {
          label: `Fix: ${fix}`,
          checked: gone.fix.includes(item.check),
          message: Message.ToggledFix({ check: item.check }),
        },
        h,
      ),
  })

const checklistLine = (
  {
    item,
    tone,
    after,
  }: {
    readonly item: PreflightItem
    readonly tone: Tone
    readonly after: ReadonlyArray<Html>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    item.check,
    [
      h.DataAttribute('check', item.check),
      h.DataAttribute('tone', tone),
      h.Class('flex flex-wrap items-baseline gap-8 text-xs'),
    ],
    [toneMark(tone, h), h.span([h.Class('text-fg')], [item.text]), ...after],
  )

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** The ready and question-only counts, and the questions to answer. */
const countsLine = (preflight: Preflight, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.DataAttribute('preflight-counts', ''), h.Class('text-xs text-muted')],
    [
      [
        plural(preflight.ready, 'ticket ready', 'tickets ready'),
        plural(
          preflight.waitingOnQuestions,
          'waits only on questions',
          'wait only on questions',
        ),
        plural(
          preflight.questions.length,
          'question to answer',
          'questions to answer',
        ),
      ].join(' · '),
    ],
  )

const buttons = (items: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex flex-wrap items-center gap-8')], items)

const cancelButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.CancelledChecklist()),
      h.Class(ghostButton),
    ],
    ['Cancel'],
  )

const checkAgainButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedCheckAgain()),
      h.Class(ghostButton),
    ],
    ['Check again'],
  )

/** The refusals, each to fix or override, the warnings with their fixes, and the counts. */
const reviewBody = (
  gone: Extract<Checklist, { readonly _tag: 'Reviewing' }>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { preflight } = gone
  const left = standing(gone).length
  const questions = preflight.questions.length
  const lines = [
    ...preflight.refusals.map(item =>
      checklistLine(
        {
          item,
          tone: 'stop',
          after: [
            fixBox(gone, item, h),
            checkbox(
              {
                label: 'Override',
                checked: gone.override.includes(item.check),
                message: Message.ToggledOverride({ check: item.check }),
              },
              h,
            ),
          ],
        },
        h,
      ),
    ),
    ...preflight.warnings.map(item =>
      checklistLine(
        { item, tone: 'warning', after: [fixBox(gone, item, h)] },
        h,
      ),
    ),
  ]
  return [
    lines.length === 0
      ? h.p([h.Class('text-xs text-muted')], ['Nothing refused or warned of.'])
      : h.ul(
          [
            h.AriaLabel('Refusals and warnings'),
            h.Class('flex flex-col gap-6'),
          ],
          lines,
        ),
    countsLine(preflight, h),
    left === 0
      ? h.empty
      : h.p(
          [h.Role('status'), h.Class('text-xs text-c3')],
          [`Fix or override ${plural(left, 'refusal', 'refusals')} to go on.`],
        ),
    buttons(
      [
        h.button(
          [
            h.Type('button'),
            h.Disabled(left > 0),
            h.OnClick(Message.ClickedContinue()),
            h.Class(primaryButton),
          ],
          [
            questions === 0
              ? 'Start overnight'
              : `Answer ${plural(questions, 'question', 'questions')}`,
          ],
        ),
        checkAgainButton(h),
        cancelButton(h),
      ],
      h,
    ),
  ]
}

const questionLine = (left: QuestionLeft, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    left.ticket,
    [h.DataAttribute('question', left.ticket), h.Class('text-xs')],
    [
      h.span([h.Class('font-mono text-fg')], [left.ticket]),
      ...Option.match(left.title, {
        onNone: () => [],
        onSome: title => [h.span([h.Class('text-fg')], [` ${title}`])],
      }),
      left.holds.length === 0
        ? h.empty
        : h.span(
            [h.Class('text-muted')],
            [` · holds ${left.holds.join(', ')}`],
          ),
    ],
  )

/** The questions, answered in the answer talk; the start, leaving those still open named. */
const answeringBody = (
  gone: Extract<Checklist, { readonly _tag: 'Answering' }>,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const left = questionsLeft(gone, inputs.attention)
  const asked = gone.preflight.questions.length
  return [
    h.p(
      [h.Role('status'), h.Class('text-xs text-fg')],
      [
        left.length === 0
          ? 'Every question is answered.'
          : `${asked - left.length} of ${asked} answered in the answer talk.`,
      ],
    ),
    left.length === 0
      ? h.empty
      : h.ul(
          [h.AriaLabel('Questions still open'), h.Class('flex flex-col gap-4')],
          left.map(question => questionLine(question, h)),
        ),
    countsLine(gone.preflight, h),
    buttons(
      [
        h.button(
          [
            h.Type('button'),
            h.OnClick(Message.ClickedStartOvernight()),
            h.Class(primaryButton),
          ],
          [
            left.length === 0
              ? 'Start overnight'
              : `Start, leaving ${plural(left.length, 'question', 'questions')} open`,
          ],
        ),
        cancelButton(h),
      ],
      h,
    ),
  ]
}

/** The pre-flight checklist of the scoped project, while it has no run. */
const checklist = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const shown =
    inputs.live &&
    Option.isNone(inputs.run) &&
    Option.exists(checklistProject(model.checklist), project =>
      Option.contains(inputs.project, project),
    )
  return !shown
    ? h.empty
    : h.section(
        [
          h.AriaLabel('Overnight pre-flight'),
          h.DataAttribute('layout', 'preflight'),
          h.Class(
            'flex flex-col gap-8 rounded-card border border-line bg-panel px-12 py-8',
          ),
        ],
        [
          h.h2(
            [h.Class('text-sm font-bold text-fg')],
            ['Overnight pre-flight'],
          ),
          ...Checklist.match(model.checklist, {
            None: () => [],
            Checking: () => [
              h.p(
                [h.Role('status'), h.Class('text-xs text-muted')],
                ['Running the pre-flight…'],
              ),
              buttons([cancelButton(h)], h),
            ],
            Failed: ({ reason }) => [
              h.p(
                [h.Role('status'), h.Class('text-xs text-c3')],
                [`The pre-flight couldn’t run: ${reason}.`],
              ),
              buttons([checkAgainButton(h), cancelButton(h)], h),
            ],
            Reviewing: gone => reviewBody(gone, h),
            Answering: gone => answeringBody(gone, inputs, h),
          }),
        ],
      )
}

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      strip(model, inputs, h),
      row(model, inputs, h),
      checklist(model, inputs, h),
    ],
  ),
)
