import { DateTime, Effect, Match, Option, Schema, Stream } from 'effect'

import {
  Acted,
  type AlreadyAnswered,
  AnswerPermissionTool,
  AnswerQuestionTool,
  AttentionAnswer,
  type AttentionNotFound,
  AttentionRequest,
  CancelTicketTool,
  CloseTicketTool,
  DeferTicketTool,
  DrainRunTool,
  Edge,
  HoldTicketTool,
  type InvalidAnswer,
  LabelTicketTool,
  MessageWorkerTool,
  type NoRun,
  OpenAnswerTalkTool,
  OpenRequestsTool,
  PermissionDecision,
  PermissionShown,
  type ProjectNotFound,
  QuestionAnswer,
  RunEventsTool,
  RunLogTool,
  RunMode,
  RunStatus,
  RunTalkView,
  RunViewTool,
  StartRunTool,
  StopRunTool,
  TalkContext,
  TalkFileTicketTool,
  type TalkId,
  TicketDetail,
  type TicketId,
  TicketMetadata,
  TicketShowTool,
  TicketWhyTool,
  TicketsReadyTool,
  type Tool,
  ToolRefusal,
  UndrainRunTool,
  UpdateTicketTool,
  type WorkerNotFound,
  WorkerTranscriptTool,
} from '@fabrica/contracts'

import type { AttentionRequestsShape } from '../attention/service'
import { readFileTail } from '../files'
import type { ProjectsShape } from '../projects/service'
import { given, whyOf } from '../rpc/backlog'
import type { RunsShape } from '../run/registry'
import { logPath, readEvents } from '../runlog'
import {
  type TalkModeOf,
  type TalkTool,
  type TalkToolContext,
  talkTool,
} from './core'

// The run talk (spec §15.4, §18.3, H44): the console's conversation with the run, one per project, its
// Pi session kept across the app's restarts. It reads the run and its tickets and acts through the
// engine's commands, on the maintainer's instructions; it has no tool but these, not even Pi's readers,
// so it edits no code and runs no git or shell command. Every command it carries out is a record of the
// event stream (`talk_action`, actor `run_talk`): on the run going's, which History follows, or with
// none on the project's stream under its last run. Stopping a run, closing or cancelling a ticket and
// allowing a permission request take the maintainer's word first: the first call is refused with the
// line to ask, naming exactly what it would do, and only the same call in the turn the maintainer's next
// message opens goes through (`confirmed`), so none comes by the model's word alone; that the message
// says yes is for the model to read. Its work graph changes are the talk's session's.

/** What the talk's tools act on, beside the talk's own context. */
export interface RunTalkServices {
  readonly runs: RunsShape
  readonly attention: AttentionRequestsShape
  readonly projects: ProjectsShape
}

/** How an answer it gives is named as answering (§8.5). */
const answeredBy = 'the run talk'

export const runInstructions = [
  "You are the console's conversation with this project's run: the maintainer talks to you to see what the run is doing and to steer it.",
  'Read before you answer: run_view, run_events, the ticket tools, worker_transcript, run_log and open_requests tell you where things stand. Answer shortly, from what they say.',
  "Act only on the maintainer's instructions, through your commands: message a worker; start, drain or undrain a run; hold a ticket until another merges; file, update, defer or label tickets; answer a question in the maintainer's words; open the answer talk. Say what you did, in a line.",
  'Before you stop a run, close or cancel a ticket, or allow a permission request, confirm in one line. The call is refused with confirm_first and the line to ask: ask the maintainer that, end your turn, and call it again, the same call, only when their next message says yes; if it says anything else, drop it.',
  'You have no other tools: you edit no code and run no git or shell command. What needs code goes to a worker, as a message or a ticket.',
].join('\n\n')

const refuse = (issue: string) => ToolRefusal.cases.invalid.make({ issue })

/** What the work graph refuses, in its words; its store failing is a defect of the call. */
const graphRefusals = <A, R>(
  effect: Effect.Effect<
    A,
    | { readonly _tag: 'StoreFailed' }
    | {
        readonly _tag:
          | 'TicketNotFound'
          | 'InvalidTicket'
          | 'EdgeCycle'
          | 'TransitionRefused'
        readonly message: string
      },
    R
  >,
): Effect.Effect<A, ToolRefusal, R> =>
  Effect.catch(effect, error =>
    error._tag === 'StoreFailed'
      ? Effect.die(error)
      : Effect.fail(refuse(error.message)),
  )

/** Fails unless the maintainer has answered `action`, asked in one line. */
const confirming = (action: string, context: TalkToolContext<'run'>) =>
  Effect.flatMap(context.confirmed(action), answered =>
    answered
      ? Effect.void
      : Effect.fail(ToolRefusal.cases.confirm_first.make({ action })),
  )

/** The project going under the talk, in words. */
const projectGone = () => Effect.fail(refuse('the project is gone'))

/** A run command's refusals, in words. */
const onTheRun = <A>(
  effect: Effect.Effect<A, ProjectNotFound | NoRun>,
): Effect.Effect<A, ToolRefusal> =>
  Effect.catch(effect, (error): Effect.Effect<never, ToolRefusal> =>
    Effect.fail(
      refuse(
        error._tag === 'NoRun'
          ? 'the project has no run going'
          : 'the project is gone',
      ),
    ),
  )

/** A worker command's refusals, in words. */
const onTheWorker = <A>(
  effect: Effect.Effect<A, ProjectNotFound | WorkerNotFound>,
): Effect.Effect<A, ToolRefusal> =>
  Effect.catch(effect, (error): Effect.Effect<never, ToolRefusal> =>
    Effect.fail(
      refuse(
        error._tag === 'WorkerNotFound'
          ? `no worker is at ${error.ticket} in the project's run`
          : 'the project is gone',
      ),
    ),
  )

/** An answer's refusals, in words. */
const answerRefusals = <A>(
  effect: Effect.Effect<A, AlreadyAnswered | AttentionNotFound | InvalidAnswer>,
): Effect.Effect<A, ToolRefusal> =>
  Effect.catch(effect, (error): Effect.Effect<never, ToolRefusal> =>
    Effect.fail(
      refuse(
        Match.value(error).pipe(
          Match.tag(
            'AlreadyAnswered',
            ({ by }) => `${by} has answered it already`,
          ),
          Match.tag('AttentionNotFound', () => 'no such open request'),
          Match.tag('InvalidAnswer', ({ reason }) => reason),
          Match.exhaustive,
        ),
      ),
    ),
  )

/** What a command did: History's line, the ticket it is about, and what else the maintainer should hear. */
interface Action {
  readonly text: string
  readonly ticket?: TicketId
  readonly also?: string
  readonly talk?: TalkId
}

/** What a command answers with. */
const answerOf = ({ text, also }: Action): Acted => ({
  text,
  ...(also === undefined ? {} : { also }),
})

/** A permission request's call in a line, so the maintainer confirms what it does. */
const callLine = PermissionShown.match({
  command: ({ lines }) => lines.join('; '),
  edit: ({ path }) => `edit ${path}`,
  write: ({ path }) => `write ${path}`,
  call: ({ input }) => JSON.stringify(input),
})

/** The latest `last` of `items`. */
const latest = <A>(items: ReadonlyArray<A>, last: number) => items.slice(-last)

export const runMode = ({
  runs,
  attention,
  projects,
}: RunTalkServices): TalkModeOf<'run'> => {
  /** Writes the record of what the talk did. */
  const record = (
    context: TalkToolContext<'run'>,
    tool: string,
    { text, ticket, talk }: Action,
  ) =>
    runs.record(context.project.id, {
      kind: 'talk_action',
      actor: 'run_talk',
      tool,
      ...(ticket === undefined ? {} : { ticket }),
      ...(talk === undefined ? {} : { talk }),
      text,
    })

  /** `tool` as a command: `act`, then its record, answering what it did. */
  const command = <
    Parameters extends Schema.Struct<Schema.Struct.Fields> & {
      readonly DecodingServices: never
    },
  >(
    tool: Tool<Parameters, typeof Acted>,
    act: (
      input: Parameters['Type'],
      context: TalkToolContext<'run'>,
    ) => Effect.Effect<Action, ToolRefusal>,
  ): TalkTool<'run'> =>
    talkTool(tool, (input, context) =>
      act(input, context).pipe(
        Effect.tap(action => record(context, tool.name, action)),
        Effect.map(answerOf),
      ),
    )

  /** Closes a ticket as `resolution`, the maintainer having said so, naming the tickets it leaves blocked. */
  const closing =
    (resolution: 'done' | 'cancelled', verb: string, done: string) =>
    (
      { id, reason }: { readonly id: TicketId; readonly reason: string },
      context: TalkToolContext<'run'>,
    ) =>
      Effect.gen(function* () {
        const graph = yield* context.graph
        const { ticket } = yield* graphRefusals(graph.show(id))
        yield* confirming(`${verb} ${id} "${ticket.title}"`, context)
        const { offers } = yield* graphRefusals(
          graph.close({
            id,
            resolution,
            reason,
            actor: context.actor,
          }),
        )
        return {
          text: `Run talk ${done} ${id}: ${ticket.title}`,
          ticket: id,
          ...(offers.length === 0
            ? {}
            : {
                also: `Still open behind it: ${offers.map(({ id: offer }) => offer).join(', ')}`,
              }),
        }
      })

  const tools: ReadonlyArray<TalkTool<'run'>> = [
    // What it reads.
    talkTool(RunViewTool, (_input, { project }) =>
      Effect.gen(function* () {
        const status = yield* runs.status(project.id)
        if (RunStatus.guards.idle(status))
          return RunTalkView.cases.idle.make({ last: status.last })
        const item = yield* Stream.runHead(
          runs.watchView({ project: project.id, resume: Option.none() }),
        )
        // A new watcher's first item is the view whole.
        return Option.isSome(item) && item.value._tag === 'snapshot'
          ? RunTalkView.cases.going.make({ view: item.value.value })
          : yield* Effect.fail(refuse("the run's view has ended: ask again"))
      }).pipe(
        Effect.catchTag('NoRun', () =>
          Effect.fail(refuse('the run has just ended: ask again')),
        ),
        Effect.catchTag('ProjectNotFound', projectGone),
      ),
    ),
    talkTool(RunEventsTool, ({ last }, { project }) => {
      const count = Option.getOrElse(last, () => 50)
      return runs
        .watchEvents({
          project: project.id,
          run: Option.none(),
          resume: Option.none(),
        })
        .pipe(
          Stream.runHead,
          Effect.map(item =>
            Option.isSome(item) && item.value._tag === 'snapshot'
              ? item.value.value
              : [],
          ),
          // With no run going, the project's last.
          Effect.catchTag('NoRun', () =>
            readEvents({ root: project.path, run: Option.none() }).pipe(
              Effect.map(({ events }) =>
                events.filter(({ run }) => run === events.at(-1)?.run),
              ),
              Effect.catch(error => Effect.fail(refuse(error.message))),
            ),
          ),
          Effect.catchTag('RunNotFound', () =>
            Effect.fail(refuse('the project has no such run')),
          ),
          Effect.catchTag('ProjectNotFound', projectGone),
          Effect.map(events => latest(events, count)),
        )
    }),
    talkTool(TicketShowTool, ({ id }, { graph }) =>
      Effect.flatMap(graph, ({ show }) => graphRefusals(show(id))).pipe(
        Effect.map(detail => new TicketDetail(detail)),
      ),
    ),
    talkTool(TicketWhyTool, ({ id }, { graph, project }) =>
      Effect.gen(function* () {
        const [work, onBase] = yield* Effect.all(
          [graph, projects.onBase(project.id)],
          { concurrency: 'unbounded' },
        )
        return whyOf(yield* graphRefusals(work.why({ id, onBase })))
      }).pipe(Effect.catchTag('ProjectNotFound', projectGone)),
    ),
    talkTool(TicketsReadyTool, (_input, { graph, project }) =>
      Effect.gen(function* () {
        const [work, onBase] = yield* Effect.all(
          [graph, projects.onBase(project.id)],
          { concurrency: 'unbounded' },
        )
        return yield* graphRefusals(work.ready({ onBase }))
      }).pipe(Effect.catchTag('ProjectNotFound', projectGone)),
    ),
    talkTool(WorkerTranscriptTool, ({ ticket, last }, { project }) =>
      runs
        .watchTranscript({
          project: project.id,
          ticket,
          resume: Option.none(),
        })
        .pipe(
          Stream.runHead,
          onTheWorker,
          Effect.map(item =>
            latest(
              Option.isSome(item) && item.value._tag === 'snapshot'
                ? item.value.value
                : [],
              Option.getOrElse(last, () => 30),
            ),
          ),
        ),
    ),
    talkTool(RunLogTool, ({ last }, { project }) =>
      readFileTail(
        { root: project.path, path: logPath },
        Option.getOrElse(last, () => 100),
      ).pipe(
        // A project that has never run has no log.
        Effect.catchTag('FileMissing', () => Effect.succeed([])),
        Effect.catch(error => Effect.fail(refuse(error.message))),
      ),
    ),
    talkTool(OpenRequestsTool, (_input, { project }) =>
      attention
        .list(Option.some(project.id))
        .pipe(Effect.catchTag('ProjectNotFound', projectGone)),
    ),

    // The engine's commands.
    command(MessageWorkerTool, ({ ticket, text }, { project }) =>
      runs.message({ project: project.id, ticket, text }).pipe(
        onTheWorker,
        Effect.as({
          text: `Run talk messaged the worker of ${ticket}`,
          ticket,
        }),
      ),
    ),
    command(StartRunTool, ({ ticket, limit }, { project }) =>
      runs
        .start({
          project: project.id,
          mode: Option.match(ticket, {
            onNone: () => RunMode.cases.tickets.make({}),
            onSome: one => RunMode.cases.ticket.make({ ticket: one }),
          }),
          flags: {
            limit,
            offline: false,
            settings: {},
            environment: {},
            preflight: Option.none(),
          },
        })
        .pipe(
          Effect.catchTag('RunGoing', ({ run }) =>
            Effect.fail(refuse(`the run ${run} is going already`)),
          ),
          Effect.catchTag('RunRefused', ({ problems }) =>
            Effect.fail(refuse(`the run didn't start: ${problems.join('; ')}`)),
          ),
          Effect.catchTag('ProjectNotFound', projectGone),
          Effect.map(run => ({
            text: `Run talk started the run ${run}${Option.match(ticket, {
              onNone: () => '',
              onSome: one => ` on ${one}`,
            })}`,
            ...Option.match(ticket, {
              onNone: () => ({}),
              onSome: one => ({ ticket: one }),
            }),
          })),
        ),
    ),
    command(DrainRunTool, (_input, { project }) =>
      runs
        .drain(project.id)
        .pipe(onTheRun, Effect.as({ text: 'Run talk drained the run' })),
    ),
    command(UndrainRunTool, (_input, { project }) =>
      runs
        .undrain(project.id)
        .pipe(onTheRun, Effect.as({ text: 'Run talk took the drain back' })),
    ),
    // Its record goes first: once stopped, the run writes its last records and is gone.
    talkTool(StopRunTool, (_input, context) =>
      Effect.gen(function* () {
        const status = yield* runs
          .status(context.project.id)
          .pipe(Effect.catchTag('ProjectNotFound', projectGone))
        if (RunStatus.guards.idle(status))
          return yield* Effect.fail(refuse('the project has no run going'))
        yield* confirming('stop the run', context)
        const action = { text: 'Run talk stopped the run' }
        yield* record(context, StopRunTool.name, action)
        yield* onTheRun(runs.stop(context.project.id))
        return answerOf(action)
      }),
    ),
    command(HoldTicketTool, ({ ticket, until }, { graph, actor }) =>
      Effect.gen(function* () {
        if (ticket === until)
          return yield* Effect.fail(
            refuse('a ticket is never held until itself'),
          )
        const work = yield* graph
        yield* graphRefusals(
          work.addDependency({
            edge: new Edge({ from: until, to: ticket, kind: 'blocks' }),
            actor,
          }),
        )
        return { text: `Run talk held ${ticket} until ${until} merges`, ticket }
      }),
    ),
    command(TalkFileTicketTool, (input, { graph, actor }) =>
      Effect.gen(function* () {
        const metadata = yield* Schema.decodeUnknownEffect(TicketMetadata)(
          Option.match(input.files, {
            onNone: () => ({}),
            onSome: files => (files === 'unknown' ? {} : { files }),
          }),
        ).pipe(Effect.catch(issue => Effect.fail(refuse(issue.message))))
        const work = yield* graph
        const filed = yield* graphRefusals(
          work.create({
            ticket: {
              type: input.type,
              title: input.title,
              description: input.description,
              ...given('design', input.design),
              ...given('acceptance', input.acceptance),
              ...given('priority', input.priority),
              ...given('labels', input.labels),
              ...given('parent', input.parent),
              metadata,
            },
            actor,
          }),
        )
        return {
          text: `Run talk filed ${filed.id}: ${filed.title}`,
          ticket: filed.id,
        }
      }),
    ),
    command(UpdateTicketTool, ({ id, ...fields }, { graph, actor }) =>
      Effect.gen(function* () {
        const changes = {
          ...given('title', fields.title),
          ...given('priority', fields.priority),
          ...Option.match(fields.description, {
            onNone: () => ({}),
            onSome: description => ({
              description: Option.some(description),
            }),
          }),
          ...Option.match(fields.design, {
            onNone: () => ({}),
            onSome: design => ({ design: Option.some(design) }),
          }),
          ...Option.match(fields.acceptance, {
            onNone: () => ({}),
            onSome: acceptance => ({ acceptance: Option.some(acceptance) }),
          }),
        }
        const named = Object.keys(changes)
        if (named.length === 0)
          return yield* Effect.fail(refuse('it names no change'))
        const work = yield* graph
        yield* graphRefusals(work.update({ id, changes, actor }))
        return {
          text: `Run talk updated ${id}: ${named.join(', ')}`,
          ticket: id,
        }
      }),
    ),
    command(DeferTicketTool, ({ id, until }, { graph, actor }) =>
      Effect.gen(function* () {
        const work = yield* graph
        yield* graphRefusals(work.defer({ id, until, actor }))
        return {
          text: Option.match(until, {
            onNone: () => `Run talk deferred ${id}`,
            onSome: time =>
              `Run talk deferred ${id} until ${DateTime.formatIso(time)}`,
          }),
          ticket: id,
        }
      }),
    ),
    command(LabelTicketTool, ({ id, add, remove }, { graph, actor }) =>
      Effect.gen(function* () {
        const adding = Option.getOrElse(add, () => [])
        const removing = Option.getOrElse(remove, () => [])
        if (adding.length === 0 && removing.length === 0)
          return yield* Effect.fail(refuse('it names no label'))
        const work = yield* graph
        // A ticket the project doesn't have is refused, whatever the labels.
        yield* graphRefusals(work.show(id))
        yield* Effect.forEach(
          adding,
          label => graphRefusals(work.label({ id, label, actor })),
          { discard: true },
        )
        yield* Effect.forEach(
          removing,
          label => graphRefusals(work.unlabel({ id, label, actor })),
          { discard: true },
        )
        return {
          text: `Run talk labelled ${id}: ${[
            ...adding.map(label => `+${label}`),
            ...removing.map(label => `-${label}`),
          ].join(' ')}`,
          ticket: id,
        }
      }),
    ),
    command(CloseTicketTool, closing('done', 'close', 'closed')),
    command(CancelTicketTool, closing('cancelled', 'cancel', 'cancelled')),
    command(AnswerQuestionTool, ({ question, answer }, { project }) =>
      attention
        .answer({
          answer: AttentionAnswer.cases.question.make({
            project: project.id,
            ticket: question,
            answer: QuestionAnswer.cases.text.make({ text: answer }),
          }),
          by: answeredBy,
        })
        .pipe(
          answerRefusals,
          Effect.as({
            text: `Run talk answered ${question} in the maintainer's words`,
            ticket: question,
          }),
        ),
    ),
    command(AnswerPermissionTool, ({ id, decision }, context) =>
      Effect.gen(function* () {
        const { project } = context
        const requests = yield* attention
          .list(Option.some(project.id))
          .pipe(Effect.catchTag('ProjectNotFound', projectGone))
        const request = requests
          .filter(AttentionRequest.guards.permission)
          .find(open => open.id === id)
        if (request === undefined)
          return yield* Effect.fail(
            refuse(`no permission request ${id} is open`),
          )
        const words = PermissionDecision.match(decision, {
          allow_once: () => Option.some('once'),
          allow_run: () => Option.some('for this run'),
          refuse: () => Option.none(),
        })
        if (Option.isSome(words))
          yield* confirming(
            `allow ${request.tool} for ${request.ticket} ${words.value}, request ${id}: ${callLine(request.shown)}`,
            context,
          )
        yield* attention
          .answer({
            answer: AttentionAnswer.cases.permission.make({
              project: project.id,
              id,
              decision,
            }),
            by: answeredBy,
          })
          .pipe(answerRefusals)
        return {
          text: Option.match(words, {
            onNone: () =>
              `Run talk refused ${request.tool} for ${request.ticket}`,
            onSome: word =>
              `Run talk allowed ${request.tool} for ${request.ticket} ${word}`,
          }),
          ticket: request.ticket,
        }
      }),
    ),
    talkTool(
      OpenAnswerTalkTool,
      ({ questions }, context: TalkToolContext<'run'>) =>
        context
          .openTalk(
            TalkContext.cases.answer.make({
              questions: Option.getOrElse(questions, () => []),
            }),
          )
          .pipe(
            Effect.catchTag('TalkNotOpened', ({ reason }) =>
              Effect.fail(refuse(reason)),
            ),
            Effect.catchTag('ProjectNotFound', projectGone),
            Effect.map(({ talk, model }) => ({
              text: `Run talk opened the answer talk ${talk}`,
              talk,
              model,
            })),
            Effect.tap(({ text, talk }) =>
              record(context, OpenAnswerTalkTool.name, { text, talk }),
            ),
          ),
    ),
  ]

  return {
    keep: true,
    readsCode: false,
    instructions: runInstructions,
    tools,
    // It waits for the maintainer's first message; a kept session resumes as it was.
    opening: () => Effect.succeedNone,
  }
}
