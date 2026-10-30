import { Array, Effect, Option, Schema } from 'effect'
import { Command, Mount, type Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  Diff,
  type FileDiff,
  Report,
  RunId,
  Text,
  TicketId,
} from '@fabrica/contracts'

import { EngineProject, sameProject } from '../app/engine-project'
import { type EngineServices, requestProject } from '../app/engine-route'
import { sidesOf } from '../mounts/diff'
import { showDiff } from '../mounts/monaco'

// The Review screen (spec §18.4): a ticket's branch diff and a run's merged diff, each file in Monaco's
// diff view, the project's run reports, and the tail of its human log, all read from the Review group
// (§8.1). A set-aside ticket's Review button (§18.3) opens its branch diff; reached from navigation, the
// screen shows the scoped project's last report and its log, and the run going, where one is, as its
// diff. A report offers its run's merged diff. Answers that arrive for a diff or a project no longer
// shown are dropped, so a slow answer never replaces a newer choice.

/** What the screen shows: a diff, the report, or the log. */
export const Tab = Schema.Literals(['diff', 'report', 'log'])
export type Tab = typeof Tab.Type

/** Whose diff: a ticket's branch against its merge base with Base, or what a run merged into Base. */
export const Subject = defineTaggedUnion({
  Ticket: { project: EngineProject, ticket: TicketId },
  Run: { project: EngineProject, run: RunId },
})
export type Subject = typeof Subject.Type

const sameSubject = Schema.toEquivalence(Subject)

export const Model = Schema.Struct({
  /** The project whose reports and log are shown. */
  project: Schema.Option(EngineProject),
  tab: Tab,
  subject: Schema.Option(Subject),
  diff: AsyncData.Schema(Diff, Schema.String).schema,
  /** The file shown, by its path; the diff's first while none is chosen. */
  file: Schema.Option(Text),
  /** What the diff view said where Monaco couldn't draw the file: its patch is shown as text instead. */
  viewProblem: Schema.Option(Schema.String),
  report: AsyncData.Schema(Report, Schema.String).schema,
  log: AsyncData.Schema(Schema.Array(Schema.String), Schema.String).schema,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  project: Option.none(),
  tab: 'diff',
  subject: Option.none(),
  diff: AsyncData.Idle(),
  file: Option.none(),
  viewProblem: Option.none(),
  report: AsyncData.Idle(),
  log: AsyncData.Idle(),
})

export const Message = defineMessageUnion({
  SelectedTab: { tab: Tab },
  SelectedFile: { path: Text },
  RequestedRunDiff: { project: EngineProject, run: RunId },
  RequestedLog: {},
  SucceededLoadDiff: { subject: Subject, diff: Diff },
  FailedLoadDiff: { subject: Subject, reason: Schema.String },
  SucceededLoadReport: { project: EngineProject, report: Report },
  FailedLoadReport: { project: EngineProject, reason: Schema.String },
  SucceededLoadLog: {
    project: EngineProject,
    lines: Schema.Array(Schema.String),
  },
  FailedLoadLog: { project: EngineProject, reason: Schema.String },
  /** Monaco drew the file, or couldn't. */
  CompletedShowDiff: {},
  FailedShowDiff: { path: Text, reason: Schema.String },
})
export type Message = typeof Message.Type

/** How many of the log's last lines the screen reads. */
export const logLines = 400

// Commands: each a request to the engine, its failure in words.

export const LoadDiff = Command.define('LoadDiff', {
  args: { subject: Subject },
  messages: [Message.SucceededLoadDiff, Message.FailedLoadDiff],
  execute: ({ subject }) =>
    requestProject(subject.project, client =>
      Subject.match<Effect.Effect<Diff, unknown>>(subject, {
        Ticket: ({ project, ticket }) =>
          client.rpc['diff.ticket']({ project: project.project, ticket }).pipe(
            Effect.catchTag('NoBranch', () =>
              Effect.fail(
                `${ticket} has no branch: it was never dispatched, or its worktree is gone.`,
              ),
            ),
          ),
        Run: ({ project, run }) =>
          client.rpc['diff.run']({ project: project.project, run }),
      }),
    ).pipe(
      Effect.map(diff => Message.SucceededLoadDiff({ subject, diff })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadDiff({ subject, reason })),
      ),
    ),
})

/** The project's last run's report. */
export const LoadReport = Command.define('LoadReport', {
  args: { project: EngineProject },
  messages: [Message.SucceededLoadReport, Message.FailedLoadReport],
  execute: ({ project }) =>
    requestProject(project, client =>
      client.rpc['report.get']({
        project: project.project,
        run: Option.none(),
      }).pipe(
        Effect.catchTags({
          NoRun: () => Effect.fail('The project has had no run yet.'),
          NoReport: () =>
            Effect.fail("The last run hasn't written its report yet."),
        }),
      ),
    ).pipe(
      Effect.map(report => Message.SucceededLoadReport({ project, report })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadReport({ project, reason })),
      ),
    ),
})

export const LoadLog = Command.define('LoadLog', {
  args: { project: EngineProject },
  messages: [Message.SucceededLoadLog, Message.FailedLoadLog],
  execute: ({ project }) =>
    requestProject(project, client =>
      client.rpc['log.tail']({ project: project.project, lines: logLines }),
    ).pipe(
      Effect.map(({ lines }) => Message.SucceededLoadLog({ project, lines })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadLog({ project, reason })),
      ),
    ),
})

/** Monaco's diff view of one file's two sides, drawn in the element it is mounted on, until it goes. */
export const ShowDiff = Mount.define('ShowDiff', {
  args: {
    path: Text,
    key: Schema.String,
    original: Schema.String,
    modified: Schema.String,
  },
  messages: [Message.CompletedShowDiff, Message.FailedShowDiff],
  execute: ({ element, path, key, original, modified }) =>
    showDiff({ element, path, key, sides: { original, modified } }).pipe(
      Effect.as(Message.CompletedShowDiff()),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedShowDiff({ path, reason })),
      ),
    ),
})

/** What the screen's Commands need: the engines' connections. */
export type Requires = EngineServices

type Return = Update.Return<Model, Message, Requires>

/** Data being asked for afresh: what was shown kept meanwhile, or asked for anew. */
const reload = <A>(
  data: AsyncData.AsyncData<A, string>,
): AsyncData.AsyncData<A, string> =>
  Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data)

/**
 * Shows `project`'s report and log and `subject`'s diff on `tab`: those already shown asked for again,
 * what they showed kept meanwhile; another project's or another subject's asked for anew.
 */
const show = (
  model: Model,
  {
    project,
    subject,
    tab,
  }: {
    readonly project: EngineProject
    readonly subject: Option.Option<Subject>
    readonly tab: Tab
  },
): Return => {
  const keptProject = Option.exists(model.project, shown =>
    sameProject(shown, project),
  )
  const keptSubject = Option.match(Option.all([model.subject, subject]), {
    onNone: () => Option.isNone(model.subject) && Option.isNone(subject),
    onSome: ([shown, chosen]) => sameSubject(shown, chosen),
  })
  const report = keptProject ? reload(model.report) : AsyncData.Loading()
  const log = keptProject ? reload(model.log) : AsyncData.Loading()
  const diff = Option.isNone(subject)
    ? AsyncData.Idle()
    : keptSubject
      ? reload(model.diff)
      : AsyncData.Loading()
  return {
    model: modifyFields(model, {
      project: () => Option.some(project),
      tab: () => tab,
      subject: () => subject,
      diff: () => diff,
      file: file => (keptSubject ? file : Option.none()),
      viewProblem: problem => (keptSubject ? problem : Option.none()),
      report: () => report,
      log: () => log,
    }),
    commands: [
      ...Option.match(subject, {
        onNone: () => [],
        onSome: chosen => [LoadDiff({ subject: chosen })],
      }),
      LoadReport({ project }),
      LoadLog({ project }),
    ],
  }
}

/** A set-aside ticket's Review (§18.3): its branch diff, beside its project's report and log. */
export const openTicket = (
  model: Model,
  {
    project,
    ticket,
  }: { readonly project: EngineProject; readonly ticket: TicketId },
): Return =>
  show(model, {
    project,
    subject: Option.some(Subject.Ticket({ project, ticket })),
    tab: 'diff',
  })

/**
 * As the screen opens from navigation: `project`, the scope, or the project shown last while the
 * scope is every project; its diff kept where it is that project's, else the run going (`run`).
 */
export const opened = (
  model: Model,
  {
    project,
    run,
  }: {
    readonly project: Option.Option<EngineProject>
    readonly run: Option.Option<RunId>
  },
): Return =>
  Option.match(
    Option.orElse(project, () => model.project),
    {
      onNone: () => ({ model }),
      onSome: shown =>
        show(model, {
          project: shown,
          subject: Option.filter(model.subject, subject =>
            sameProject(subject.project, shown),
          ).pipe(
            Option.orElse(() =>
              Option.map(run, going =>
                Subject.Run({ project: shown, run: going }),
              ),
            ),
          ),
          tab: model.tab,
        }),
    },
  )

/** Whether an answer about `subject` is for the diff the screen shows. */
const showsSubject = (model: Model, subject: Subject): boolean =>
  Option.exists(model.subject, shown => sameSubject(shown, subject))

/** Shows the view `tab`, as its button or its key chooses it. */
export const selectTab = (model: Model, tab: Tab): Model =>
  model.tab === tab ? model : modifyFields(model, { tab: () => tab })

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SelectedTab: ({ tab }) => ({ model: selectTab(model, tab) }),
    SelectedFile: ({ path }) => ({
      model: modifyFields(model, {
        file: () => Option.some(path),
        viewProblem: () => Option.none(),
      }),
    }),
    // A report's run diff: its project's report and log are those shown already.
    RequestedRunDiff: ({ project, run }) => {
      const subject = Subject.Run({ project, run })
      return showsSubject(model, subject)
        ? { model: selectTab(model, 'diff') }
        : {
            model: modifyFields(model, {
              tab: () => 'diff' as const,
              subject: () => Option.some(subject),
              diff: () => AsyncData.Loading(),
              file: () => Option.none(),
              viewProblem: () => Option.none(),
            }),
            commands: [LoadDiff({ subject })],
          }
    },
    RequestedLog: () =>
      Option.match(model.project, {
        onNone: () => ({ model }),
        onSome: project => ({
          model: modifyFields(model, { log: reload }),
          commands: [LoadLog({ project })],
        }),
      }),
    SucceededLoadDiff: ({ subject, diff }) => ({
      model: showsSubject(model, subject)
        ? modifyFields(model, { diff: () => AsyncData.succeed(diff) })
        : model,
    }),
    FailedLoadDiff: ({ subject, reason }) => ({
      model: showsSubject(model, subject)
        ? modifyFields(model, { diff: () => AsyncData.fail(reason) })
        : model,
    }),
    SucceededLoadReport: ({ project, report }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, { report: () => AsyncData.succeed(report) })
        : model,
    }),
    FailedLoadReport: ({ project, reason }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, { report: () => AsyncData.fail(reason) })
        : model,
    }),
    SucceededLoadLog: ({ project, lines }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, { log: () => AsyncData.succeed(lines) })
        : model,
    }),
    FailedLoadLog: ({ project, reason }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, { log: () => AsyncData.fail(reason) })
        : model,
    }),
    CompletedShowDiff: () => ({ model }),
    FailedShowDiff: ({ path, reason }) => ({
      model: Option.exists(
        Option.flatMap(AsyncData.getData(model.diff), diff =>
          shownFile(model, diff),
        ),
        file => file.path === path,
      )
        ? modifyFields(model, { viewProblem: () => Option.some(reason) })
        : model,
    }),
  })

/** The file the diff view shows: the one chosen, or the diff's first. */
export const shownFile = (model: Model, diff: Diff): Option.Option<FileDiff> =>
  Option.match(model.file, {
    onNone: () => Array.head(diff.files),
    onSome: path =>
      Array.findFirst(diff.files, file => file.path === path).pipe(
        Option.orElse(() => Array.head(diff.files)),
      ),
  })

// The view.

const tabTitle: Record<Tab, string> = {
  diff: 'Diff',
  report: 'Report',
  log: 'Log',
}

const changeWord: Record<FileDiff['change'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
}

const button =
  'rounded-button border border-line px-10 py-4 text-xs font-bold hover:brightness-108 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-c1'

const note = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('text-xs text-muted')], [text])

const problemLine = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

/** A commit as the screen names it: its first 7 characters, as git abbreviates it. */
const shortCommit = (commit: string): string => commit.slice(0, 7)

const subjectTitle = (subject: Subject): string =>
  Subject.match(subject, {
    Ticket: ({ ticket }) => `${ticket}'s branch`,
    Run: ({ run }) => `What run ${run} merged`,
  })

/** The key the diff view's models are named by, and its element keyed on, per subject and file. */
const subjectKey = (subject: Subject): string =>
  Subject.match(subject, {
    Ticket: ({ ticket }) => `ticket/${ticket}`,
    Run: ({ run }) => `run/${run}`,
  })

const tabs = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.AriaLabel('Review views'), h.Class('flex gap-6')],
    Tab.literals.map(tab =>
      h.button(
        [
          h.Type('button'),
          h.AriaPressed(model.tab === tab ? 'true' : 'false'),
          h.OnClick(Message.SelectedTab({ tab })),
          h.Class(
            `${button} ${model.tab === tab ? 'bg-panel text-fg' : 'text-muted'}`,
          ),
        ],
        [tabTitle[tab]],
      ),
    ),
  )

const fileList = (diff: Diff, shown: FileDiff, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.AriaLabel('Changed files'),
      h.Class('flex w-260 shrink-0 flex-col gap-4 overflow-auto'),
    ],
    diff.files.map(file =>
      h.button(
        [
          h.Type('button'),
          h.AriaPressed(file.path === shown.path ? 'true' : 'false'),
          h.OnClick(Message.SelectedFile({ path: file.path })),
          h.Class(
            `flex flex-col items-start rounded-button px-8 py-4 text-left font-mono text-xs hover:brightness-108 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-c1 ${file.path === shown.path ? 'bg-panel font-bold text-fg' : 'text-muted'}`,
          ),
        ],
        [
          h.span([], [file.path]),
          h.span(
            [h.Class('text-muted')],
            [
              Option.match(file.from, {
                onNone: () => changeWord[file.change],
                onSome: from => `${changeWord[file.change]} from ${from}`,
              }),
            ],
          ),
        ],
      ),
    ),
  )

/** A patch as text, where Monaco can't show it: a binary file, or a view that failed to draw. */
const patchText = (file: FileDiff, h: HtmlBuilder<Message>): Html =>
  h.pre(
    [
      h.AriaLabel(`Patch of ${file.path}`),
      h.Class(
        'min-h-0 flex-1 overflow-auto rounded-card bg-panel p-12 font-mono text-xs whitespace-pre',
      ),
    ],
    [file.patch === '' ? 'No change to its text.' : file.patch],
  )

const fileView = (
  model: Model,
  subject: Subject,
  file: FileDiff,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.filter(sidesOf(file), () => Option.isNone(model.viewProblem)),
    {
      onNone: () =>
        h.div(
          [h.Class('flex min-h-0 flex-1 flex-col gap-8')],
          [
            Option.match(model.viewProblem, {
              onNone: () => h.empty,
              onSome: reason =>
                problemLine(`The diff view couldn't draw it: ${reason}`, h),
            }),
            patchText(file, h),
          ],
        ),
      onSome: ({ original, modified }) =>
        h.keyed('div')(`${subjectKey(subject)}:${file.path}`, [
          h.Role('region'),
          h.AriaLabel(`Diff of ${file.path}`),
          h.Class('min-h-0 flex-1 overflow-hidden rounded-card bg-panel'),
          h.OnMount(
            ShowDiff({
              path: file.path,
              key: subjectKey(subject),
              original,
              modified,
            }),
          ),
        ]),
    },
  )

const diffView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.subject, {
    onNone: () =>
      note(
        "No diff chosen: a set-aside ticket's Review opens its branch, and a run's report its merged diff.",
        h,
      ),
    onSome: subject =>
      h.section(
        [
          h.AriaLabel(subjectTitle(subject)),
          h.Class('flex min-h-0 flex-1 flex-col gap-8'),
        ],
        [
          h.h3([h.Class('text-sm font-extrabold')], [subjectTitle(subject)]),
          AsyncData.matchData(model.diff, {
            onEmpty: () => note('Reading the diff…', h),
            onFailure: reason =>
              problemLine(`The diff couldn't be read: ${reason}`, h),
            onData: diff =>
              Option.match(shownFile(model, diff), {
                onNone: () => note('No file changed.', h),
                onSome: shown =>
                  h.div(
                    [h.Class('flex min-h-0 flex-1 flex-col gap-8')],
                    [
                      note(
                        `${diff.files.length === 1 ? '1 file' : `${diff.files.length} files`} · ${shortCommit(diff.base)} → ${shortCommit(diff.head)}`,
                        h,
                      ),
                      h.div(
                        [h.Class('flex min-h-0 flex-1 gap-12')],
                        [
                          fileList(diff, shown, h),
                          fileView(model, subject, shown, h),
                        ],
                      ),
                    ],
                  ),
              }),
          }),
        ],
      ),
  })

const reportView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchData(model.report, {
    onEmpty: () => note('Reading the last report…', h),
    onFailure: reason => problemLine(reason, h),
    onData: report =>
      h.article(
        [
          h.AriaLabel(`Report of run ${report.run}`),
          h.Class('flex min-h-0 flex-1 flex-col gap-8'),
        ],
        [
          h.div(
            [h.Class('flex items-center gap-12')],
            [
              h.h3([h.Class('text-sm font-extrabold')], [`Run ${report.run}`]),
              ...Option.match(model.project, {
                onNone: () => [],
                onSome: project => [
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(
                        Message.RequestedRunDiff({ project, run: report.run }),
                      ),
                      h.Class(`${button} text-fg`),
                    ],
                    ["The run's merged diff"],
                  ),
                ],
              }),
            ],
          ),
          h.pre(
            [
              h.Class(
                'min-h-0 flex-1 overflow-auto rounded-card bg-panel p-12 font-mono text-xs whitespace-pre-wrap',
              ),
            ],
            [report.markdown],
          ),
        ],
      ),
  })

const logView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.AriaLabel('Log'), h.Class('flex min-h-0 flex-1 flex-col gap-8')],
    [
      h.div(
        [h.Class('flex items-center gap-12')],
        [
          h.h3(
            [h.Class('text-sm font-extrabold')],
            [`The log's last ${logLines} lines`],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.RequestedLog()),
              h.Class(`${button} text-fg`),
            ],
            ['Read again'],
          ),
        ],
      ),
      AsyncData.matchData(model.log, {
        onEmpty: () => note('Reading the log…', h),
        onFailure: reason =>
          problemLine(`The log couldn't be read: ${reason}`, h),
        onData: lines =>
          lines.length === 0
            ? note('The log is empty.', h)
            : h.pre(
                [
                  h.Class(
                    'min-h-0 flex-1 overflow-auto rounded-card bg-panel p-12 font-mono text-xs whitespace-pre',
                  ),
                ],
                [lines.join('\n')],
              ),
      }),
    ],
  )

export const view = defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-12')],
    Option.match(model.project, {
      onNone: () => [
        note(
          "Choose a project in the sidebar to review its runs, or a set-aside ticket's Review.",
          h,
        ),
      ],
      onSome: () => [
        tabs(model, h),
        {
          diff: () => diffView(model, h),
          report: () => reportView(model, h),
          log: () => logView(model, h),
        }[model.tab](),
      ],
    }),
  ),
)
