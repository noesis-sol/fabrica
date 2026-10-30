import {
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from 'effect'
import { SqlClient } from 'effect/sql'
import { mkdir, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  AddFailed,
  type ProjectId,
  ProjectInfo,
  ProjectNotFound,
  ProjectRunState,
  type ProjectSettings,
  ProjectSource,
  ProjectStatus,
  type ProjectStatusItem,
  type Resume,
  type TicketId,
} from '@fabrica/contracts'

import { EngineFiles } from '../engine/paths'
import {
  CloneOutcome,
  Git,
  type GitShape,
  type WorktreeHome,
  ticketBranch,
} from '../git'
import type { SettingsProblems } from '../settings'
import {
  type OnBase,
  WorkGraph,
  type WorkGraphShape,
  sqliteLayer,
} from '../workgraph'
import { ProjectCheck, checkProject } from './check'
import {
  clonePath,
  excludeIgnored,
  makeFabricaFolder,
  projectFolder,
  workGraphPath,
  worktreeHome,
} from './layout'
import { nameOf, projectIdFor, ticketPrefixFor } from './names'
import {
  type ProjectRecord,
  deleteRecord,
  findRecord,
  insertRecord,
  listRecords,
  updateTrust,
} from './records'
import { readSettings, settingsExist, writeSettings } from './settings'
import { makeStatusFeed } from './status'

// The Projects service (spec §10.1, §10.2, §8.1): the engine's projects, each a checkout on its host,
// registered where it is or cloned from a URL into `<data>/projects/<id>/repo/` with the host's git
// credentials. Adding one checks it (`checkProject`), keeps the work graph's files out of git, makes
// its `.fabrica/` and opens its work graph on `.fabrica/work.db`; a project that can't be used is
// refused with every problem, and a clone it made is removed again. Each project's work graph is
// opened once, in a scope of its own that its removal closes, and every change to it updates the
// project's row in the status stream. Removing a project forgets it and the engine's folder for it;
// a registered checkout stays where it is.

/** A project's work graph couldn't be opened: its checkout is gone, its database is newer than the engine. */
export class WorkGraphUnopened extends Data.TaggedError('WorkGraphUnopened')<{
  readonly project: ProjectId
  readonly reason: string
}> {
  override get message() {
    return `the work graph of ${this.project} couldn't be opened: ${this.reason}`
  }
}

export interface ProjectsShape {
  readonly add: (options: {
    readonly source: ProjectSource
    readonly name: Option.Option<string>
  }) => Effect.Effect<ProjectInfo, AddFailed>
  /** Every project, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<ProjectInfo>>
  /** Forgets the project and removes the engine's folder for it (a clone with it); a registered checkout stays. */
  readonly remove: (project: ProjectId) => Effect.Effect<void, ProjectNotFound>
  readonly find: (
    project: ProjectId,
  ) => Effect.Effect<ProjectRecord, ProjectNotFound>
  /**
   * Keeps whether the user trusts the project (§12.1, §20.2): its agents started from then on load
   * its own Pi settings and packages only while it is trusted. A project is added untrusted. Its row
   * is sent again with it.
   */
  readonly setTrusted: (options: {
    readonly project: ProjectId
    readonly trusted: boolean
  }) => Effect.Effect<void, ProjectNotFound>
  /** Keeps the project's run as its row says it (§18.3), and sends the row again with it. */
  readonly setRun: (options: {
    readonly project: ProjectId
    readonly run: ProjectRunState
  }) => Effect.Effect<void, ProjectNotFound>
  /** Where the project's worktrees go (§10.2). */
  readonly worktreeHome: (
    project: ProjectId,
  ) => Effect.Effect<WorktreeHome, ProjectNotFound>
  /** The project's settings, every one its file doesn't hold at its default. */
  readonly settings: (
    project: ProjectId,
  ) => Effect.Effect<ProjectSettings, ProjectNotFound | SettingsProblems>
  readonly setSettings: (options: {
    readonly project: ProjectId
    readonly settings: ProjectSettings
  }) => Effect.Effect<void, ProjectNotFound | SettingsProblems>
  /** The project's work graph, opened on its `.fabrica/work.db` the first time it is asked for. */
  readonly workGraph: (
    project: ProjectId,
  ) => Effect.Effect<WorkGraphShape, ProjectNotFound | WorkGraphUnopened>
  /** Whether a closed ticket of the project is on its Base, as the ready rule asks it (§13.3). */
  readonly onBase: (
    project: ProjectId,
  ) => Effect.Effect<OnBase, ProjectNotFound>
  /** The projects' rows (§18.3), as a snapshot or the patches after `resume`, then each change. */
  readonly watchStatus: (
    resume: Option.Option<Resume>,
  ) => Stream.Stream<ProjectStatusItem>
}

export class Projects extends Context.Service<Projects, ProjectsShape>()(
  '@fabrica/engine/Projects',
) {}

interface Opened {
  readonly graph: WorkGraphShape
  readonly scope: Scope.Closeable
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Whether the closed blocker `ticket` is on Base: its branch merged into it. A failure to tell is no. */
const onBaseOf =
  (git: GitShape, record: ProjectRecord): OnBase =>
  (ticket: TicketId) =>
    git
      .isOnBase({
        repo: record.path,
        branch: `refs/heads/${ticketBranch(ticket)}`,
        base: `refs/heads/${record.base}`,
      })
      .pipe(Effect.orElseSucceed(() => false))

/** The Projects service on Git, the engine's files and engine.db, its work graphs held in the layer's scope. */
export const make = Effect.gen(function* () {
  const git = yield* Git
  const sql = yield* SqlClient.SqlClient
  const { data } = yield* EngineFiles
  const scope = yield* Effect.scope
  const withSql = Effect.provideService(SqlClient.SqlClient, sql)
  const withGit = Effect.provideService(Git, git)
  const opened = yield* Ref.make<ReadonlyMap<ProjectId, Opened>>(new Map())
  const openLock = yield* Semaphore.make(1)
  const addLock = yield* Semaphore.make(1)
  /** Each project's run, as the runs say it; idle where none is kept. */
  const runs = yield* Ref.make<ReadonlyMap<ProjectId, ProjectRunState>>(
    new Map(),
  )

  const find = (project: ProjectId) =>
    withSql(findRecord(project)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ProjectNotFound({ project })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const infoOf = (record: ProjectRecord) =>
    Effect.map(
      settingsExist(record.path),
      setUp =>
        new ProjectInfo({
          id: record.id,
          name: record.name,
          path: record.path,
          origin: record.origin,
          url: record.url,
          base: record.base,
          setUp,
          trusted: record.trusted,
        }),
    )

  const statusFeed = yield* makeStatusFeed([])

  /** Sends the project's row again, as it is now. */
  const refresh = (record: ProjectRecord): Effect.Effect<void> =>
    Effect.flatMap(statusOf(record), statusFeed.upsert)

  /** Opens the project's work graph where it isn't open, with a watcher that sends its row on each change. */
  const open = (
    record: ProjectRecord,
  ): Effect.Effect<WorkGraphShape, WorkGraphUnopened> =>
    openLock.withPermit(
      Effect.gen(function* () {
        const held = (yield* Ref.get(opened)).get(record.id)
        if (held !== undefined) return held.graph
        const own = yield* Scope.fork(scope)
        const built = yield* Layer.buildWithScope(
          sqliteLayer({
            prefix: ticketPrefixFor(record.name),
            filename: NodePath.join(record.path, workGraphPath),
          }),
          own,
        ).pipe(
          Effect.mapError(
            error =>
              new WorkGraphUnopened({
                project: record.id,
                reason: reasonOf(error),
              }),
          ),
          Effect.tapError(() => Scope.close(own, Exit.void)),
        )
        const graph = Context.get(built, WorkGraph)
        const changes = yield* graph.changes.pipe(
          Effect.provideService(Scope.Scope, own),
          Effect.mapError(
            error =>
              new WorkGraphUnopened({
                project: record.id,
                reason: reasonOf(error),
              }),
          ),
          Effect.tapError(() => Scope.close(own, Exit.void)),
        )
        yield* changes.pipe(
          Stream.runForEach(() => refresh(record)),
          Effect.catch(error =>
            Effect.logWarning(
              `the work graph of ${record.id} stopped sending its changes: ${error.message}`,
            ),
          ),
          Effect.forkIn(own),
        )
        yield* Ref.update(opened, map =>
          new Map(map).set(record.id, { graph, scope: own }),
        )
        return graph
      }),
    )

  /** Closes the project's work graph, where it is open. */
  const close = (project: ProjectId) =>
    openLock.withPermit(
      Effect.gen(function* () {
        const held = (yield* Ref.get(opened)).get(project)
        if (held === undefined) return
        yield* Ref.update(opened, map => {
          const next = new Map(map)
          next.delete(project)
          return next
        })
        yield* Scope.close(held.scope, Exit.void)
      }),
    )

  /** The project's row: its run as the runs say it, its ready tickets. */
  const statusOf = (record: ProjectRecord): Effect.Effect<ProjectStatus> =>
    Effect.gen(function* () {
      const run =
        (yield* Ref.get(runs)).get(record.id) ??
        ProjectRunState.cases.idle.make({})
      const [setUp, ready] = yield* Effect.all(
        [
          settingsExist(record.path),
          open(record).pipe(
            Effect.flatMap(graph =>
              graph.ready({ onBase: onBaseOf(git, record) }),
            ),
            Effect.map(tickets => tickets.length),
            Effect.catch(error =>
              Effect.as(
                Effect.logWarning(
                  `the ready tickets of ${record.id} couldn't be read: ${error.message}`,
                ),
                0,
              ),
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      )
      return new ProjectStatus({
        project: record.id,
        name: record.name,
        base: record.base,
        setUp,
        trusted: record.trusted,
        run,
        ready,
      })
    })

  // Each project's row, its work graph opened.
  yield* Effect.forEach(yield* withSql(listRecords), refresh, {
    concurrency: 'unbounded',
    discard: true,
  })

  const refused = (reason: string) => new AddFailed({ reason })

  /** Makes the checked checkout at `place` a project: its ignore rules, `.fabrica/`, its work graph, its record. */
  const register = Effect.fn('Projects.register')(function* (options: {
    readonly id: ProjectId
    readonly name: string
    readonly folder: string
    readonly origin: ProjectRecord['origin']
    readonly url: Option.Option<string>
  }) {
    const checked = yield* withGit(checkProject(options.folder))
    const { place, base } = yield* ProjectCheck.$match(checked, {
      Usable: usable => Effect.succeed(usable),
      Unusable: ({ problems }) => Effect.fail(refused(problems.join('; '))),
    })
    const known = (yield* withSql(listRecords)).find(
      ({ path }) => path === place.top,
    )
    if (known !== undefined)
      return yield* refused(`${place.top} is already the project ${known.id}`)
    yield* excludeIgnored(place.commonDir).pipe(
      Effect.mapError(error =>
        refused(`its ignore rules couldn't be written: ${error.message}`),
      ),
    )
    yield* makeFabricaFolder(place.top).pipe(
      Effect.mapError(error => refused(error.message)),
    )
    const record: ProjectRecord = {
      id: options.id,
      name: options.name,
      path: place.top,
      origin: options.origin,
      url: options.url,
      base,
      trusted: false,
    }
    yield* open(record).pipe(Effect.mapError(error => refused(error.message)))
    yield* withSql(insertRecord(record))
    yield* refresh(record)
    return yield* infoOf(record)
  })

  /** Clones `url` into the project's folder; the clone is removed again where it couldn't be added. */
  const cloneAndRegister = Effect.fn('Projects.clone')(function* (options: {
    readonly id: ProjectId
    readonly name: string
    readonly url: string
  }) {
    if (options.url.startsWith('-'))
      return yield* refused(`${options.url} isn't a git URL`)
    const into = clonePath({ data, project: options.id })
    const removeClone = Effect.promise(() =>
      rm(into, { recursive: true, force: true }),
    )
    yield* Effect.tryPromise({
      try: () =>
        mkdir(NodePath.dirname(into), { recursive: true, mode: 0o700 }),
      catch: error =>
        refused(
          `${NodePath.dirname(into)} couldn't be made: ${reasonOf(error)}`,
        ),
    })
    // Whatever ends the add before the project is kept (git refused, timed out, the check, an
    // interruption), the clone goes with it.
    return yield* Effect.gen(function* () {
      const cloned = yield* git
        .clone({ url: options.url, into })
        .pipe(
          Effect.mapError(error =>
            refused(`git clone ${error.command}: ${error.reason}`),
          ),
        )
      yield* CloneOutcome.$match(cloned, {
        Cloned: () => Effect.void,
        Refused: ({ message }) => Effect.fail(refused(message)),
      })
      return yield* register({
        id: options.id,
        name: options.name,
        folder: into,
        origin: 'cloned',
        url: Option.some(options.url),
      })
    }).pipe(
      Effect.onExit(exit => (Exit.isSuccess(exit) ? Effect.void : removeClone)),
    )
  })

  const add = Effect.fn('Projects.add')(function* (options: {
    readonly source: ProjectSource
    readonly name: Option.Option<string>
  }) {
    const name = Option.getOrElse(options.name, () => nameOf(options.source))
    return yield* addLock.withPermit(
      Effect.gen(function* () {
        const taken = new Set((yield* withSql(listRecords)).map(({ id }) => id))
        const id = projectIdFor(name, taken)
        return yield* ProjectSource.match(options.source, {
          path: ({ path }) =>
            NodePath.isAbsolute(path)
              ? register({
                  id,
                  name,
                  folder: NodePath.normalize(path),
                  origin: 'registered',
                  url: Option.none(),
                })
              : Effect.fail(
                  refused(
                    `${path} isn't an absolute path: the engine can't tell what it is relative to`,
                  ),
                ),
          url: ({ url }) => cloneAndRegister({ id, name, url }),
        })
      }),
    )
  })

  const list = Effect.flatMap(withSql(listRecords), records =>
    Effect.forEach(records, infoOf, { concurrency: 'unbounded' }),
  ).pipe(Effect.withSpan('Projects.list'))

  const remove = Effect.fn('Projects.remove')(function* (project: ProjectId) {
    yield* find(project)
    yield* close(project)
    yield* withSql(deleteRecord(project))
    yield* statusFeed.remove(project)
    yield* Effect.promise(() =>
      rm(projectFolder({ data, project }), { recursive: true, force: true }),
    )
  })

  const setTrusted = Effect.fn('Projects.setTrusted')(function* (options: {
    readonly project: ProjectId
    readonly trusted: boolean
  }) {
    const record = yield* find(options.project)
    yield* withSql(updateTrust(options))
    yield* refresh({ ...record, trusted: options.trusted })
  })

  const setRun = Effect.fn('Projects.setRun')(function* (options: {
    readonly project: ProjectId
    readonly run: ProjectRunState
  }) {
    const record = yield* find(options.project)
    yield* Ref.update(runs, map =>
      new Map(map).set(options.project, options.run),
    )
    yield* refresh(record)
  })

  const settings = Effect.fn('Projects.settings')(function* (
    project: ProjectId,
  ) {
    const record = yield* find(project)
    return yield* readSettings(record.path)
  })

  const setSettings = Effect.fn('Projects.setSettings')(function* (options: {
    readonly project: ProjectId
    readonly settings: ProjectSettings
  }) {
    const record = yield* find(options.project)
    yield* writeSettings({
      checkout: record.path,
      settings: options.settings,
    }).pipe(
      // A settings file the engine can't write is its fault, not the settings'.
      Effect.catch(error =>
        error._tag === 'SettingsProblems'
          ? Effect.fail(error)
          : Effect.die(error),
      ),
    )
    yield* refresh(record)
  })

  return Projects.of({
    add,
    list,
    remove,
    find,
    setTrusted,
    setRun,
    worktreeHome: project =>
      Effect.map(find(project), record =>
        worktreeHome({
          data,
          project,
          checkout: record.path,
          origin: record.origin,
        }),
      ),
    settings,
    setSettings,
    workGraph: project => Effect.flatMap(find(project), open),
    onBase: project =>
      Effect.map(find(project), record => onBaseOf(git, record)),
    watchStatus: statusFeed.watch,
  })
})

/** The Projects service, its work graphs closed as the layer's scope ends. */
export const layer = Layer.effect(Projects, make)
