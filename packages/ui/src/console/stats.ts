import { Array, type DateTime, Effect, Match, Option, Schema } from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Command, type ManagedResource, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  type Banner,
  type EngineStep,
  type Hold,
  type NoRun,
  ProjectId,
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
import {
  EngineConnection,
  type EngineConnectionService,
} from '../app/connection'
import { waitingWords } from './waiting'

// The console's stats row (spec §18.3, H80, H81; Appendix A.2), for the scoped project's run: live
// workers against the slots, done today, set aside, needs you, in queue with how many of them wait
// (each with why in words on hover), and tokens; at its right end the run's controls, Start run and
// its modes while the project is idle, Drain and Stop while its run goes, and an overnight run's tag.
// Above the row, a strip of the run's holds and banners (`c2` for a hold, `c3` for a stop) with when
// each lifts, the engine's run-wide steps with their elapsed time, and a request the engine refused.
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

export const Model = Schema.Struct({
  controls: Controls,
  request: Request,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  controls: Controls.Closed(),
  request: Request.None(),
})

export const Message = defineMessageUnion({
  ClickedStartRun: {},
  ChoseMode: { project: ProjectId, mode: StartMode },
  TypedModeText: { text: Schema.String },
  ToggledRefine: {},
  SubmittedMode: { project: ProjectId },
  CancelledControls: {},
  ClickedDrain: { project: ProjectId },
  ClickedUndrain: { project: ProjectId },
  ClickedStop: {},
  ConfirmedStop: { project: ProjectId },
  SucceededStartRun: { project: ProjectId },
  SucceededRunRequest: {},
  FailedRunRequest: { action: RunAction, reason: Schema.String },
  DismissedRefusal: {},
})
export type Message = typeof Message.Type

/** What the root does on the controls' behalf: a started run's view is watched afresh. */
export const OutMessage = defineMessageUnion({
  StartedRun: { project: ProjectId },
})
export type OutMessage = typeof OutMessage.Type

/** A run started from the app: no dispatch limit, online, the project's own settings. */
export const startFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
}

/** What a run request can fail with: the engine's refusals, the connection not held, or lost. */
export type RunRequestError =
  | ProjectNotFound
  | RunGoing
  | RunRefused
  | NoRun
  | ManagedResource.ResourceNotAvailable
  | RpcClientError.RpcClientError

/** Why the engine refused a request, in words. */
export const refusalWords = (error: RunRequestError): string =>
  Match.valueTags(error, {
    RunRefused: ({ problems }) => problems.join('; '),
    RunGoing: () => 'the project has a run going already',
    NoRun: () => 'the project has no run going',
    ProjectNotFound: () => "the engine doesn't know the project",
    ResourceNotAvailable: () => 'not connected to the engine',
    RpcClientError: () => 'lost the engine before it answered',
  })

/** Starts a run of `project` in `mode`. */
export const StartRun = Command.define('StartRun', {
  args: { project: ProjectId, mode: RunMode },
  messages: [Message.SucceededStartRun, Message.FailedRunRequest],
  execute: ({ project, mode }) =>
    EngineConnection.get.pipe(
      Effect.flatMap(({ client }) =>
        client.rpc['run.start']({ project, mode, flags: startFlags }),
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
    ),
})

/** Drains, undrains or stops `project`'s run. */
export const AskRun = Command.define('AskRun', {
  args: {
    project: ProjectId,
    action: Schema.Literals(['drain', 'undrain', 'stop']),
  },
  messages: [Message.SucceededRunRequest, Message.FailedRunRequest],
  execute: ({ project, action }) =>
    EngineConnection.get.pipe(
      Effect.flatMap(({ client }) =>
        action === 'drain'
          ? client.rpc['run.drain']({ project })
          : action === 'undrain'
            ? client.rpc['run.undrain']({ project })
            : client.rpc['run.stop']({ project }),
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
  EngineConnectionService
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

const starting = (model: Model, project: ProjectId, mode: RunMode): Return => ({
  model: modifyFields(model, {
    controls: () => Controls.Closed(),
    request: () => Request.Pending({ action: 'start' }),
  }),
  commands: [StartRun({ project, mode })],
})

const asking = (
  model: Model,
  project: ProjectId,
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
          Controls.guards.Closed(controls)
            ? Controls.ChoosingMode()
            : Controls.Closed(),
      }),
    }),
    ChoseMode: ({ project, mode }) =>
      mode === 'tickets'
        ? starting(model, project, RunMode.cases.tickets.make({}))
        : mode === 'overnight'
          ? starting(model, project, RunMode.cases.overnight.make({}))
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

/** What the frame gives the row. */
export interface ViewInputs {
  /** The project the sidebar chose: its run's controls are the row's. */
  readonly project: Option.Option<ProjectId>
  /** Whether the engine's client is held, so requests can be sent. */
  readonly live: boolean
  /** The scoped project's run view, while it has a run. */
  readonly run: Option.Option<RunView>
  /** The time now, in the viewer's zone. */
  readonly now: Option.Option<DateTime.Zoned>
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
          h.Class(`font-extrabold ${roleText[role]}`),
          h.Style({ fontSize: '20px' }),
        ],
        [value],
      ),
      h.span([h.Class('text-xs font-bold text-muted')], [label]),
      ...after,
    ],
  )

const figures = (
  run: RunView,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { totals } = run
  const waiting = waitingOf(run)
  return [
    item(
      {
        name: 'live',
        value: `${totals.live} of ${totals.slots}`,
        label: 'Workers live',
        role: 'c1',
      },
      h,
    ),
    item(
      {
        name: 'done',
        value: String(totals.counts.done),
        label: 'Done today',
        role: 'c4',
      },
      h,
    ),
    item(
      {
        name: 'set-aside',
        value: String(totals.counts.set_aside),
        label: 'Set aside',
        role: 'c3',
      },
      h,
    ),
    item(
      {
        name: 'needs-you',
        value: String(totals.counts.needs_you),
        label: 'Needs you',
        role: 'c2',
      },
      h,
    ),
    item(
      {
        name: 'in-queue',
        value: String(totals.counts.in_queue),
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
        value: sayTokens(tokenTotal(totals.tokens)),
        label: 'Tokens',
        role: 'c5',
      },
      h,
    ),
  ]
}

const primaryButton =
  'rounded-button bg-c1 px-12 py-6 text-sm font-bold text-ink shadow-glow1 hover:brightness-[1.08] disabled:opacity-60'
const ghostButton =
  'rounded-button border border-line px-12 py-6 text-sm text-fg hover:brightness-[1.08] disabled:opacity-60'

const modeMenu = (project: ProjectId, h: HtmlBuilder<Message>): Html =>
  h.ul(
    [
      h.Role('menu'),
      h.AriaLabel('Start run'),
      h.Class(
        'absolute right-0 top-full z-10 mt-4 flex flex-col rounded-card border border-line bg-panel py-4 shadow-glow1',
      ),
      h.Style({ minWidth: '200px' }),
    ],
    StartMode.literals.map(mode =>
      h.keyed('li')(
        mode,
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.Role('menuitem'),
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
  project: ProjectId,
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
        h.OnInput(text => Message.TypedModeText({ text })),
        h.Class(
          'rounded-button border border-line bg-bg px-8 py-4 text-sm text-fg',
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
        [h.Type('submit'), h.Disabled(!ready), h.Class(primaryButton)],
        ['Start'],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.CancelledControls()),
          h.Class(ghostButton),
        ],
        ['Cancel'],
      ),
    ],
  )
}

/** Start run, its modes or a mode's field: the project is idle. */
const idleControls = (
  model: Model,
  project: ProjectId,
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
              h.Class(primaryButton),
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
  project: ProjectId,
  state: RunState,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const busy = Request.guards.Pending(model.request) || state === 'stopping'
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
            h.Class(ghostButton),
          ],
          ['Undrain'],
        )
      : h.button(
          [
            h.Type('button'),
            h.Disabled(busy),
            h.OnClick(Message.ClickedDrain({ project })),
            h.Class(ghostButton),
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
                'rounded-button bg-c3 px-12 py-6 text-sm font-bold text-ink hover:brightness-[1.08]',
              ),
            ],
            ['Stop the run'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.CancelledControls()),
              h.Class(ghostButton),
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
              h.Class(ghostButton),
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
  Option.match(inputs.live ? inputs.project : Option.none(), {
    onNone: () => h.empty,
    onSome: project =>
      h.div(
        [
          h.Role('group'),
          h.AriaLabel('Run controls'),
          h.Class('ml-auto flex items-center gap-8'),
          h.Style({ padding: '6px 12px' }),
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

const row = (model: Model, inputs: ViewInputs, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute('layout', 'stats-row'),
      h.Class(
        'flex flex-wrap items-center rounded-card border border-line bg-panel',
      ),
    ],
    [
      ...Option.match(inputs.run, {
        onNone: () => [
          h.span(
            [h.Class('text-sm text-muted'), h.Style({ padding: '10px 18px' })],
            [
              Option.isSome(inputs.project)
                ? 'No run'
                : 'Choose a project for its run',
            ],
          ),
        ],
        onSome: run => figures(run, h),
      }),
      controls(model, inputs, h),
    ],
  )

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [strip(model, inputs, h), row(model, inputs, h)],
  ),
)
