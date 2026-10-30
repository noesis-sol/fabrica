import { Array, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  EngineId,
  type ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  type RunId,
  applyKeyedPatch,
} from '@fabrica/contracts'

import { localEngineName } from '../app/connection'
import { applyItems } from '../app/streams'

// The console's sidebar: projects and their runs (spec §18.3, H43; Appendix A.2). Header "Projects"
// and the count; an "All projects" row, then one row per project on every known engine: its chip in
// its colour (the five role colours in turn, by its index) holding its two-digit index, its name, its
// Base and, where more than one engine is known, the engine's name, and its run's state on the right.
// Selecting a row scopes the main area to it; "+ Add project" is pinned at the bottom. A selected row
// is marked by its left bar and background and by `aria-current`, a run's state in a word beside its
// colour, so neither rests on colour alone (§18.2).

/** One known engine's projects: none until its status stream's first snapshot. */
export const EngineProjects = Schema.Struct({
  engine: EngineId,
  /** The engine's name, as the app's known engines name it (§9.1). */
  name: Schema.String,
  projects: Schema.Option(Schema.Array(ProjectStatus)),
})
export type EngineProjects = typeof EngineProjects.Type

export const Model = Schema.Struct({
  /** The known engines, in the order they became known. */
  engines: Schema.Array(EngineProjects),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ engines: [] })

const byProject = {
  of: (status: ProjectStatus) => status.project,
  gone: (project: ProjectId) => project,
}

/**
 * `engine`'s project status items applied to its rows: a snapshot takes their place, a patch changes
 * them. An engine not known yet joins the list at its end; the other engines keep their identity.
 */
export const receivedProjects = (
  model: Model,
  {
    engine,
    name,
    items,
  }: {
    readonly engine: EngineId
    readonly name: string
    readonly items: Array.NonEmptyReadonlyArray<ProjectStatusItem>
  },
): Model => {
  const apply = (current: EngineProjects): EngineProjects => ({
    engine,
    name,
    projects: applyItems(current.projects, items, (rows, patch) =>
      applyKeyedPatch(rows, patch, byProject),
    ),
  })
  return model.engines.some(known => known.engine === engine)
    ? {
        engines: model.engines.map(known =>
          known.engine === engine ? apply(known) : known,
        ),
      }
    : {
        engines: [
          ...model.engines,
          apply({ engine, name, projects: Option.none() }),
        ],
      }
}

/** The role colours a project's chip takes in turn, by its index. */
export type Role = 'c1' | 'c2' | 'c3' | 'c4' | 'c5'

const roles: Array.NonEmptyReadonlyArray<Role> = ['c1', 'c2', 'c3', 'c4', 'c5']

/** A project's chip: its colour and its two-digit label. */
export interface Chip {
  readonly role: Role
  readonly label: string
}

/** The chip of the project at `index` (from 1): its colour, the five roles in turn, and its two-digit label. */
export const chipOf = (index: number): Chip => ({
  role: roles[(index - 1) % roles.length] ?? 'c1',
  label: String(index).padStart(2, '0'),
})

/** A project's row: its status, its engine and its index across every engine, from 1. */
export interface Row {
  readonly status: ProjectStatus
  readonly engine: EngineProjects
  readonly index: number
}

/** Every known engine's projects, in order, each with its index. */
export const rows = (model: Model): ReadonlyArray<Row> =>
  model.engines
    .flatMap(engine =>
      Option.match(engine.projects, {
        onNone: () => [],
        onSome: projects => projects.map(status => ({ status, engine })),
      }),
    )
    .map((row, at) => ({ ...row, index: at + 1 }))

/**
 * The rows of the engine the app's own connection reaches, this machine's: the runs History and the
 * notifications watch through it, until a project's streams go through its own engine's connection.
 */
export const localRows = (model: Model): ReadonlyArray<Row> =>
  rows(model).filter(row => row.engine.name === localEngineName)

/** The chip of `project`, as its row has it: cards in the All projects scope carry it (§18.3). */
export const projectChip = (
  model: Model,
  project: ProjectId,
): Option.Option<Chip> =>
  Option.map(
    Array.findFirst(rows(model), row => row.status.project === project),
    row => chipOf(row.index),
  )

/** The name of `project`, as its row has it; none while no row shows it. */
export const projectName = (
  model: Model,
  project: ProjectId,
): Option.Option<string> =>
  Option.map(
    Array.findFirst(rows(model), row => row.status.project === project),
    row => row.status.name,
  )

/** A run's state in a word, and the role colour beside it: none while idle. */
export const runLabel = (
  run: ProjectRunState,
): { readonly word: string; readonly role: Option.Option<Role> } =>
  ProjectRunState.match(run, {
    idle: () => ({ word: 'Idle', role: Option.none() }),
    running: () => ({ word: 'Running', role: Option.some<Role>('c1') }),
    waiting: () => ({ word: 'Waiting', role: Option.some<Role>('c2') }),
  })

/** Whether the project's run is an overnight one (§15.6). */
export const isOvernight = (run: ProjectRunState): boolean =>
  ProjectRunState.match(run, {
    idle: () => false,
    running: ({ overnight }) => overnight,
    waiting: ({ overnight }) => overnight,
  })

/** The run going in `project`, as its row says it: Running or Waiting; none while idle or unknown. */
export const goingRun = (
  model: Model,
  project: ProjectId,
): Option.Option<RunId> =>
  Option.flatMap(
    Array.findFirst(rows(model), row => row.status.project === project),
    row =>
      ProjectRunState.match(row.status.run, {
        idle: () => Option.none(),
        running: ({ run }) => Option.some(run),
        waiting: ({ run }) => Option.some(run),
      }),
  )

/** The line under a project's name: its Base, and its engine's name where more than one is known. */
export const baseLine = (row: Row, enginesKnown: number): string =>
  enginesKnown > 1 ? `${row.status.base} · ${row.engine.name}` : row.status.base

const chipBackground: Record<Role, string> = {
  c1: 'bg-c1',
  c2: 'bg-c2',
  c3: 'bg-c3',
  c4: 'bg-c4',
  c5: 'bg-c5',
}

/** A project's chip as the handoff draws it, 22px (Appendix A.2): its label on its colour. */
export const chipView = <Message>(chip: Chip, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('chip', chip.role),
      h.Class(
        `flex items-center justify-center rounded-button font-extrabold text-ink ${chipBackground[chip.role]}`,
      ),
      h.Style({ width: '22px', height: '22px', fontSize: '11px' }),
    ],
    [chip.label],
  )

const roleText: Record<Role, string> = {
  c1: 'text-c1',
  c2: 'text-c2',
  c3: 'text-c3',
  c4: 'text-c4',
  c5: 'text-c5',
}

/** What the frame gives the sidebar: the scope, and the Messages its rows and its button send. */
export interface Config<Message> {
  /** The project selected, or none for every project. */
  readonly scope: Option.Option<ProjectId>
  readonly messages: Messages<Message>
}

/** The sidebar's Messages, made once, so the frame's memo of the sidebar holds. */
export interface Messages<Message> {
  /** Scopes the main area to a project, or to every project. */
  readonly select: (project: Option.Option<ProjectId>) => Message
  /** Opens the engines screen's add-project flow (§10.1). */
  readonly addProject: Message
}

const rowClass = (selected: boolean): string =>
  [
    'grid w-full items-center gap-10 border-l-3 text-left',
    selected ? 'border-c1 bg-panel' : 'border-transparent hover:bg-panel/50',
  ].join(' ')

const rowStyle = {
  gridTemplateColumns: '22px minmax(0,1fr) auto',
  padding: '10px 16px',
}

const selection = <Message>(selected: boolean, h: HtmlBuilder<Message>) =>
  selected ? [h.AriaCurrent('true')] : []

const allRow = <Message>(
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const selected = Option.isNone(config.scope)
  return h.keyed('button')(
    'all',
    [
      h.Type('button'),
      h.DataAttribute('project', 'all'),
      h.OnClick(config.messages.select(Option.none())),
      ...selection(selected, h),
      h.Class(rowClass(selected)),
      h.Style(rowStyle),
    ],
    [
      h.span([h.AriaHidden(true)]),
      h.span(
        [h.Class('truncate font-semibold'), h.Style({ fontSize: '14px' })],
        ['All projects'],
      ),
      h.span([]),
    ],
  )
}

const projectRow = <Message>(
  row: Row,
  enginesKnown: number,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const { status } = row
  const selected = Option.contains(config.scope, status.project)
  const state = runLabel(status.run)
  const overnight = isOvernight(status.run)
  const base = baseLine(row, enginesKnown)
  return h.keyed('button')(
    status.project,
    [
      h.Type('button'),
      h.DataAttribute('project', status.project),
      h.OnClick(config.messages.select(Option.some(status.project))),
      ...selection(selected, h),
      h.AriaLabel(
        [
          status.name,
          base,
          state.word,
          ...(overnight ? ['overnight'] : []),
        ].join(', '),
      ),
      h.Class(rowClass(selected)),
      h.Style(rowStyle),
    ],
    [
      chipView(chipOf(row.index), h),
      h.span(
        [h.Class('flex min-w-0 flex-col'), h.Style({ gap: '2px' })],
        [
          h.span(
            [h.Class('truncate font-semibold'), h.Style({ fontSize: '14px' })],
            [status.name],
          ),
          // The Base's line is 19.4px, so that the row is the handoff's 62.4px (Appendix A.2) and the
          // Base sits under the name where the reference draws it.
          h.span(
            [
              h.Class('truncate font-mono text-xs text-muted'),
              h.Style({ lineHeight: '19.4px' }),
            ],
            [base],
          ),
        ],
      ),
      h.span(
        [h.Class('flex flex-col items-end'), h.Style({ gap: '2px' })],
        [
          h.span(
            [
              h.DataAttribute('run-state', status.run._tag),
              h.Class(
                `text-xs ${Option.match(state.role, { onNone: () => '', onSome: role => roleText[role] })}`,
              ),
            ],
            [state.word],
          ),
          overnight
            ? h.span(
                [
                  h.DataAttribute('tag', 'overnight'),
                  h.Class('font-bold text-c5'),
                  h.Style({ fontSize: '11px' }),
                ],
                ['overnight'],
              )
            : h.empty,
        ],
      ),
    ],
  )
}

export const view = <Message>(
  model: Model,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const projects = rows(model)
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      h.div(
        [
          h.Class('flex items-center justify-between'),
          h.Style({ padding: '16px 16px 10px' }),
        ],
        [
          h.h2(
            [h.Class('font-extrabold'), h.Style({ fontSize: '13px' })],
            ['Projects'],
          ),
          h.span(
            [
              h.DataAttribute('count', 'projects'),
              h.Class('text-xs text-muted'),
            ],
            [String(projects.length)],
          ),
        ],
      ),
      h.div(
        [h.Class('flex min-h-0 flex-1 flex-col overflow-auto')],
        [
          allRow(config, h),
          ...projects.map(row =>
            projectRow(row, model.engines.length, config, h),
          ),
        ],
      ),
      h.div(
        [
          h.Class('flex border-t border-line'),
          h.Style({ padding: '12px 16px' }),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(config.messages.addProject),
              h.Class(
                'flex items-center gap-8 rounded-button bg-c1 font-bold text-ink shadow-glow1',
              ),
              h.Style({ padding: '8px 12px', fontSize: '13px' }),
            ],
            [
              h.span(
                [
                  h.AriaHidden(true),
                  h.Style({ fontSize: '16px', lineHeight: '1' }),
                ],
                ['+'],
              ),
              'Add project',
            ],
          ),
        ],
      ),
    ],
  )
}
