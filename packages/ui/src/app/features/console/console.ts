import { Array, Option } from 'effect'
import { type Html, type HtmlBuilder, createLazy } from 'foldkit/html'

import {
  type AttentionRequest,
  MergeQueue,
  type TicketRow,
} from '@fabrica/contracts'

import * as InProgress from '../../../console/in-progress'
import * as Sidebar from '../../../console/sidebar'
import * as UpNext from '../../../console/up-next'
import { isLive } from '../../connection'
import { type EngineProject, sameProject } from '../../engine-project'
import { layout } from '../../layout'
import type { Message } from '../../message'
import type { Model } from '../../model'
import type { ProjectRunView } from '../../streams'
import { attentionPart } from '../attention/attention'
import { historyView } from '../history/history'
import { openWorker } from '../screen/screen'
import { lazyStatsPart } from '../stats/stats'
import { talkPanelPart } from '../talks/talks'

// The console (spec §18.3, Appendix A.1): the stats row, the run talk beside History in a row 156px
// high, and the two ticket columns, which take the remaining height and scroll each on its own. Each
// part is its submodel's view, memoised on its own slice of the Model, so a change elsewhere doesn't
// redraw it (§18.5).

const lazyStats = createLazy()
const lazyTalkPanel = createLazy()
const lazyHistory = createLazy()
const lazyInProgress = createLazy()
const lazyAllInProgress = createLazy()
const lazyAttention = createLazy()
const lazyUpNext = createLazy()
const lazyAllUpNext = createLazy()

/** The In progress column's slices of the scoped run, the same values while no run is shown. */
const noRun: InProgress.Slices = {
  tickets: [],
  workers: [],
  queue: new MergeQueue({
    merging: Option.none(),
    train: Option.none(),
    waiting: [],
  }),
  steps: [],
}

/**
 * The In progress column of a project's scope, from its run's tickets, workers, queue and steps, in its
 * project's colour, its cards unmarked.
 */
const inProgressView = (
  inProgress: InProgress.Model,
  project: EngineProject,
  tickets: InProgress.Slices['tickets'],
  workers: InProgress.Slices['workers'],
  queue: InProgress.Slices['queue'],
  steps: InProgress.Slices['steps'],
  role: Sidebar.Role,
  now: Model['now'],
  h: HtmlBuilder<Message>,
): Html =>
  InProgress.view(
    inProgress,
    {
      runs: [
        {
          project,
          tickets,
          workers,
          queue,
          steps,
          role,
          chip: Option.none(),
        },
      ],
      now,
      open: openWorker,
    },
    h,
  )

/**
 * The In progress column under All projects (§18.3): every project's run going, each card in its
 * project's colour and with its chip.
 */
const allInProgressView = (
  inProgress: InProgress.Model,
  runViews: Model['runViews'],
  sidebar: Sidebar.Model,
  now: Model['now'],
  h: HtmlBuilder<Message>,
): Html =>
  InProgress.view(
    inProgress,
    {
      runs: allRuns(runViews, sidebar).map(({ project, view, chip }) => ({
        project,
        tickets: view.tickets,
        workers: view.workers,
        queue: view.queue,
        steps: view.steps,
        role: chip.role,
        chip: Option.some(chip),
      })),
      now,
      open: openWorker,
    },
    h,
  )

/** The scoped run's project's colour, its sidebar chip's; `c1`, running, until the sidebar knows it. */
const runRole = (model: Model): Sidebar.Role =>
  Option.match(
    Option.flatMap(model.scope, project =>
      Sidebar.projectChip(model.console.sidebar, project),
    ),
    { onNone: () => 'c1', onSome: chip => chip.role },
  )

/**
 * Under All projects, every project's run going in the sidebar's order, each with its project's chip
 * (§18.3): the views are of the projects its rows show going.
 */
const allRuns = (
  runViews: Model['runViews'],
  sidebar: Sidebar.Model,
): ReadonlyArray<ProjectRunView & { readonly chip: Sidebar.Chip }> =>
  Sidebar.rows(sidebar).flatMap(row => {
    const project = Sidebar.rowProject(row)
    return Option.match(
      Array.findFirst(runViews, entry => sameProject(entry.project, project)),
      {
        onNone: () => [],
        onSome: entry => [{ ...entry, chip: Sidebar.chipOf(row.index) }],
      },
    )
  })

const noRequests: ReadonlyArray<AttentionRequest> = []

/**
 * Up next in a project's scope, memoised on its run view's ticket rows and attention requests, each the
 * same value while unchanged; its entries unmarked.
 */
const upNextView = (
  upNext: UpNext.Model,
  project: EngineProject,
  tickets: ReadonlyArray<TicketRow>,
  attention: ReadonlyArray<AttentionRequest>,
  h: HtmlBuilder<Message>,
): Html =>
  UpNext.view(
    upNext,
    { runs: [{ project, tickets, attention, chip: Option.none() }] },
    h,
  )

/** Up next under All projects (§18.3): every project's run going's queue, each entry with its chip. */
const allUpNextView = (
  upNext: UpNext.Model,
  runViews: Model['runViews'],
  sidebar: Sidebar.Model,
  h: HtmlBuilder<Message>,
): Html =>
  UpNext.view(
    upNext,
    {
      runs: allRuns(runViews, sidebar).map(({ project, view, chip }) => ({
        project,
        tickets: view.tickets,
        attention: view.attention,
        chip: Option.some(chip),
      })),
    },
    h,
  )

const panel =
  'flex flex-col overflow-hidden rounded-card border border-line bg-panel'
const column = 'flex min-h-0 flex-col gap-8 overflow-auto'

/** Whether the attention column has something to show: otherwise Up next takes its place (§18.3). */
const needsYou = (model: Model): boolean =>
  Option.exists(model.attention, requests => requests.length > 0)

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const parts = model.console
  const run = Option.getOrElse(model.runView, () => noRun)
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-16')],
    [
      h.section(
        [h.AriaLabel('Ticket stats')],
        [
          lazyStats(lazyStatsPart, [
            parts.stats,
            model.scope,
            isLive(model.connection),
            model.runView,
            model.runViews,
            model.now,
            model.attention,
            h,
          ]),
        ],
      ),
      h.div(
        [
          h.DataAttribute('layout', 'talk-row'),
          h.Class('grid gap-16'),
          h.Style({
            gridTemplateColumns: `minmax(0,1fr) ${layout.historyWidth}`,
            height: layout.talkRowHeight,
          }),
        ],
        [
          h.section(
            [h.AriaLabel('Run talk'), h.Class(panel)],
            [
              lazyTalkPanel(talkPanelPart, [
                parts.talkPanel,
                model.scope,
                isLive(model.connection),
                parts.sidebar,
                h,
              ]),
            ],
          ),
          h.section(
            [h.AriaLabel('History'), h.Class(panel)],
            [
              lazyHistory(historyView, [
                parts.history,
                model.events,
                model.scope,
                parts.sidebar,
                model.today,
                h,
              ]),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute('layout', 'ticket-columns'),
          h.Class('grid min-h-0 flex-1 gap-16'),
          h.Style({ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }),
        ],
        [
          h.section(
            [h.AriaLabel('In progress'), h.Class(column)],
            [
              Option.match(model.scope, {
                onSome: project =>
                  lazyInProgress(inProgressView, [
                    parts.inProgress,
                    project,
                    run.tickets,
                    run.workers,
                    run.queue,
                    run.steps,
                    runRole(model),
                    model.now,
                    h,
                  ]),
                onNone: () =>
                  lazyAllInProgress(allInProgressView, [
                    parts.inProgress,
                    model.runViews,
                    parts.sidebar,
                    model.now,
                    h,
                  ]),
              }),
            ],
          ),
          needsYou(model)
            ? h.section(
                [h.AriaLabel('Needs your attention'), h.Class(column)],
                [
                  lazyAttention(attentionPart, [
                    parts.attention,
                    model.engineAttention,
                    model.focusedRequest,
                    model.now,
                    isLive(model.connection),
                    model.scope,
                    parts.sidebar,
                    model.platform,
                    h,
                  ]),
                ],
              )
            : h.section(
                [h.AriaLabel('Up next'), h.Class(column)],
                [
                  Option.match(model.scope, {
                    onSome: project =>
                      lazyUpNext(upNextView, [
                        parts.upNext,
                        project,
                        run.tickets,
                        Option.match(model.runView, {
                          onNone: () => noRequests,
                          onSome: runView => runView.attention,
                        }),
                        h,
                      ]),
                    onNone: () =>
                      lazyAllUpNext(allUpNextView, [
                        parts.upNext,
                        model.runViews,
                        parts.sidebar,
                        h,
                      ]),
                  }),
                ],
              ),
        ],
      ),
    ],
  )
}
