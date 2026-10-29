import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Actor,
  AddFailed,
  ProjectId,
  ProjectNotFound,
  ProjectRpcs,
  ProjectSource,
  type ProjectStatusItem,
  Resume,
  StreamEpoch,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { type GitConfig, layer as gitLayer } from '../src/git'
import { layerHostFrom } from '../src/host'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  Projects,
  excludedEntries,
  fabricaIgnoreText,
  nameOf,
  projectIdFor,
  layer as projectsLayer,
  ticketPrefixFor,
  workGraphPath,
} from '../src/projects'
import { projectsHandlers } from '../src/rpc/projects'

// Projects (spec §10.1, §10.2, §8.1): a checkout registered where it is and a clone of a bare
// repository, against real git in temp folders; listing and removing them; their settings read and
// written; the status stream; and each project's work graph, opened on its `.fabrica/work.db` and
// opened again when the engine starts again.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-projects-')))
  home = NodePath.join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    NodePath.join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

/** The environment git runs with, the engine's and the fixtures': no configuration but the test's. */
const gitEnvironment = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LANG: 'C',
})

/** A new empty folder of the test's. */
const tempFolder = (prefix: string) =>
  Effect.sync(() => mkdtempSync(NodePath.join(root, `${prefix}-`)))

interface GitRepo {
  /** The folder holding both repositories. */
  readonly root: string
  /** The checkout: on `main`, with one commit, pushed to `remote`. */
  readonly work: string
  /** A bare repository. */
  readonly remote: string
  /** Runs git in the checkout, or in `cwd`; what it printed, trimmed. */
  readonly git: (
    args: ReadonlyArray<string>,
    cwd?: string,
  ) => Effect.Effect<string>
}

/** A checkout on `main` with one commit, and the bare repository it pushed to. */
const newRepo = Effect.gen(function* () {
  const folder = yield* tempFolder('repo')
  const work = NodePath.join(folder, 'work')
  const remote = NodePath.join(folder, 'remote.git')
  const git: GitRepo['git'] = (args, cwd = work) =>
    Effect.sync(() =>
      execFileSync('git', args, {
        cwd,
        env: { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    )
  yield* git(['init', '--quiet', '--bare', remote], folder)
  yield* git(['init', '--quiet', work], folder)
  writeFileSync(NodePath.join(work, 'README.md'), '# Test\n')
  yield* git(['add', 'README.md'])
  yield* git(['commit', '--quiet', '--message', 'First commit'])
  yield* git(['remote', 'add', 'origin', remote])
  yield* git(['push', '--quiet', '--set-upstream', 'origin', 'main'])
  return { root: folder, work, remote, git } satisfies GitRepo
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: gitEnvironment(),
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

/** The host's facts, its home the test's. */
const testHost = Layer.suspend(() =>
  layerHostFrom({
    availableParallelism: () => 2,
    totalmem: () => 8 * 1024 ** 3,
    loadavg: () => [0],
    homedir: () => home,
  }),
)

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

/** An engine's projects, on engine.db at `database` and the data folder `data`: the RPC client and the service. */
const engineAt = (options: {
  readonly data: string
  readonly database: string
}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      projectsHandlers.pipe(
        Layer.provideMerge(projectsLayer),
        Layer.provide(testHost),
        Layer.provide(
          gitLayer(gitConfig).pipe(
            Layer.provide(runnerLayer(runnerConfig())),
            Layer.provide(layerClock),
          ),
        ),
        Layer.provide(engineDatabaseLayer(options.database)),
        Layer.provide(
          Layer.succeed(EngineFiles)(
            pathsIn({ data: options.data, socketFolder: options.data }),
          ),
        ),
      ),
    )
    const client = yield* RpcTest.makeClient(ProjectRpcs).pipe(
      Effect.provide(services),
    )
    return { client, projects: Context.get(services, Projects) }
  })

/** A new engine in a data folder of its own, its engine.db in memory. */
const newEngine = Effect.gen(function* () {
  const data = yield* tempFolder('projects-data')
  return { data, ...(yield* engineAt({ data, database: ':memory:' })) }
})

const maintainer = Actor.cases.maintainer.make({})

const pathSource = (path: string) => ProjectSource.cases.path.make({ path })
const urlSource = (url: string) => ProjectSource.cases.url.make({ url })

/** The reason an add was refused with. */
const refusal = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return expect.fail('the add succeeded')
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error) || !(error.value instanceof AddFailed))
    return expect.fail(`not refused: ${Cause.pretty(exit.cause)}`)
  return error.value.reason
}

/** The error `exit` failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

/** What `git status --porcelain` says of the checkout: nothing where it is clean. */
const statusOf = (repo: GitRepo, cwd = repo.work) =>
  repo.git(['status', '--porcelain', '--untracked-files=all'], cwd)

describe('names', () => {
  it('names a project after its folder or the repository its URL names', () => {
    expect(nameOf(pathSource('/src/my-app/'))).toBe('my-app')
    expect(nameOf(urlSource('git@github.com:team/app.git'))).toBe('app')
    expect(nameOf(urlSource('https://host.test/team/tool.git/'))).toBe('tool')
    expect(nameOf(pathSource('/'))).toBe('project')
  })

  it('gives each project an ID of its own', () => {
    expect(projectIdFor('My App!', new Set())).toBe('my-app')
    expect(projectIdFor('app', new Set(['app', 'app-2']))).toBe('app-3')
    expect(projectIdFor('***', new Set())).toBe('project')
  })

  it('draws ticket prefixes from the name', () => {
    expect(ticketPrefixFor('fabrica')).toBe('fab')
    expect(ticketPrefixFor('2fa-Tool')).toBe('fat')
    expect(ticketPrefixFor('42')).toBe('fa')
  })
})

describe('projects', () => {
  it.live(
    'registers a checkout where it is, its .fabrica/ made and its files kept out of git',
    () =>
      Effect.gen(function* () {
        const repo = yield* newRepo
        const { client } = yield* newEngine
        const sub = NodePath.join(repo.work, 'src')
        yield* Effect.promise(() => mkdir(sub))

        // Given a folder inside the checkout, the engine registers the checkout's top.
        const added = yield* client['projects.add']({
          source: pathSource(sub),
          name: Option.some('Demo App'),
        })
        expect(added.id).toBe('demo-app')
        expect(added.name).toBe('Demo App')
        expect(added.path).toBe(repo.work)
        expect(added.origin).toBe('registered')
        expect(added.url).toStrictEqual(Option.none())
        expect(added.base).toBe('main')
        expect(added.setUp).toBe(false)

        expect(existsSync(NodePath.join(repo.work, workGraphPath))).toBe(true)
        const exclude = readFileSync(
          NodePath.join(repo.work, '.git', 'info', 'exclude'),
          'utf8',
        )
        for (const entry of excludedEntries) expect(exclude).toContain(entry)
        // The work graph, its journal, a run's files and a report: none shows to git.
        yield* Effect.promise(() =>
          mkdir(NodePath.join(repo.work, '.fabrica', 'run'), {
            recursive: true,
          }),
        )
        writeFileSync(NodePath.join(repo.work, '.fabrica/run/events.jsonl'), '')
        writeFileSync(NodePath.join(repo.work, '.fabrica/fabrica.log'), '')
        expect(yield* statusOf(repo)).toBe('')

        expect(yield* client['projects.list']()).toStrictEqual([added])
      }).pipe(Effect.scoped),
  )

  it.live('adds the ignore rules once, keeping the lines there', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client } = yield* newEngine
      const exclude = NodePath.join(repo.work, '.git', 'info', 'exclude')
      writeFileSync(exclude, '# mine\n*.swp')
      const project = yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      yield* client['projects.remove']({ project: project.id })
      yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      const lines = readFileSync(exclude, 'utf8').split('\n')
      expect(lines.slice(0, 2)).toStrictEqual(['# mine', '*.swp'])
      for (const entry of excludedEntries)
        expect(lines.filter(line => line === entry)).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live(
    'clones a URL into the data folder, with the remote it came from',
    () =>
      Effect.gen(function* () {
        const repo = yield* newRepo
        const { client, data } = yield* newEngine
        const added = yield* client['projects.add']({
          source: urlSource(repo.remote),
          name: Option.none(),
        })
        expect(added.id).toBe('remote')
        expect(added.origin).toBe('cloned')
        expect(added.url).toStrictEqual(Option.some(repo.remote))
        expect(added.base).toBe('main')
        const clone = NodePath.join(data, 'projects', 'remote', 'repo')
        expect(added.path).toBe(clone)
        expect(readFileSync(NodePath.join(clone, 'README.md'), 'utf8')).toBe(
          '# Test\n',
        )
        expect(existsSync(NodePath.join(clone, workGraphPath))).toBe(true)
        expect(yield* statusOf(repo, clone)).toBe('')

        // A second clone of the same URL is a project of its own.
        const again = yield* client['projects.add']({
          source: urlSource(repo.remote),
          name: Option.none(),
        })
        expect(again.id).toBe('remote-2')
        expect(
          (yield* client['projects.list']()).map(({ id }) => id),
        ).toStrictEqual(['remote', 'remote-2'])
      }).pipe(Effect.scoped),
  )

  it.live('refuses a clone git refuses, and leaves no folder for it', () =>
    Effect.gen(function* () {
      const { client, data } = yield* newEngine
      const missing = NodePath.join(data, 'nowhere.git')
      const exit = yield* Effect.exit(
        client['projects.add']({
          source: urlSource(missing),
          name: Option.some('gone'),
        }),
      )
      expect(refusal(exit)).toContain('nowhere.git')
      expect(existsSync(NodePath.join(data, 'projects', 'gone', 'repo'))).toBe(
        false,
      )
      const option = yield* Effect.exit(
        client['projects.add']({
          source: urlSource('--upload-pack=touch /tmp/x'),
          name: Option.none(),
        }),
      )
      expect(refusal(option)).toContain("isn't a git URL")
      expect(yield* client['projects.list']()).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('refuses what isn’t a checkout it can use, saying why', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client, data } = yield* newEngine
      const add = (path: string) =>
        Effect.exit(
          client['projects.add']({
            source: pathSource(path),
            name: Option.none(),
          }),
        )

      expect(refusal(yield* add(data))).toBe(`${data} is not in a git checkout`)
      expect(refusal(yield* add(NodePath.join(data, 'missing')))).toBe(
        `there is no folder at ${NodePath.join(data, 'missing')}`,
      )
      expect(refusal(yield* add('relative/app'))).toContain(
        "isn't an absolute path",
      )
      expect(refusal(yield* add(repo.remote))).toContain(
        'is not in a git checkout',
      )

      const linked = NodePath.join(repo.root, 'linked')
      yield* repo.git(['worktree', 'add', '--quiet', '-b', 'side', linked])
      expect(refusal(yield* add(linked))).toContain('is a worktree of')

      yield* repo.git(['checkout', '--quiet', '--detach'])
      expect(refusal(yield* add(repo.work))).toContain('is on no branch')
      yield* repo.git(['checkout', '--quiet', 'main'])

      // Settings that don't decode: every problem, the project not added.
      yield* Effect.promise(() => mkdir(NodePath.join(repo.work, '.fabrica')))
      writeFileSync(
        NodePath.join(repo.work, '.fabrica', 'settings.json'),
        '{ "concurrent": 0, "colour": "red" }',
      )
      const invalid = refusal(yield* add(repo.work))
      expect(invalid).toContain('concurrent')
      expect(invalid).toContain('colour')
      writeFileSync(
        NodePath.join(repo.work, '.fabrica', 'settings.json'),
        '{ "concurrent": 3 }',
      )

      const added = yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      expect(added.setUp).toBe(true)
      expect(refusal(yield* add(repo.work))).toBe(
        `${repo.work} is already the project ${added.id}`,
      )
      expect(
        (yield* client['projects.list']()).map(({ id }) => id),
      ).toStrictEqual([added.id])
    }).pipe(Effect.scoped),
  )

  it.live('refuses a .fabrica that is a link to elsewhere', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client, data } = yield* newEngine
      yield* Effect.promise(() =>
        symlink(data, NodePath.join(repo.work, '.fabrica')),
      )
      const exit = yield* Effect.exit(
        client['projects.add']({
          source: pathSource(repo.work),
          name: Option.none(),
        }),
      )
      expect(refusal(exit)).toContain('.fabrica is a symbolic link')
      expect(existsSync(NodePath.join(data, 'work.db'))).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live('removes a project: a registered checkout stays, a clone goes', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client, data } = yield* newEngine
      const registered = yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      const cloned = yield* client['projects.add']({
        source: urlSource(repo.remote),
        name: Option.some('clone'),
      })
      yield* client['projects.remove']({ project: registered.id })
      expect(existsSync(NodePath.join(repo.work, 'README.md'))).toBe(true)
      expect(existsSync(NodePath.join(repo.work, workGraphPath))).toBe(true)
      yield* client['projects.remove']({ project: cloned.id })
      expect(existsSync(NodePath.join(data, 'projects', 'clone'))).toBe(false)
      expect(yield* client['projects.list']()).toStrictEqual([])

      const project = ProjectId.make('unknown')
      const exit = yield* Effect.exit(client['projects.remove']({ project }))
      expect(failureOf(exit)).toStrictEqual(new ProjectNotFound({ project }))
    }).pipe(Effect.scoped),
  )

  it.live(
    'reads the settings, and writes only what changed, keeping the file’s formatting',
    () =>
      Effect.gen(function* () {
        const repo = yield* newRepo
        const { client } = yield* newEngine
        const { id: project } = yield* client['projects.add']({
          source: pathSource(repo.work),
          name: Option.none(),
        })
        const file = NodePath.join(repo.work, '.fabrica', 'settings.json')

        const defaults = yield* client['projects.settings.get']({ project })
        expect(defaults.concurrent).toBe(2)
        expect(defaults.model).toStrictEqual(Option.none())
        // Settings all at their defaults write nothing: the project isn't set up by them.
        yield* client['projects.settings.set']({ project, settings: defaults })
        expect(existsSync(file)).toBe(false)

        writeFileSync(
          file,
          '{\n    "concurrent": 3,\n    "check_timeout": "45m",\n    "verifier": { "rounds": 2 }\n}\n',
        )
        const read = yield* client['projects.settings.get']({ project })
        expect(read.concurrent).toBe(3)
        expect(read.verifier.rounds).toBe(2)
        expect(Duration.toMinutes(read.check_timeout)).toBe(45)

        yield* client['projects.settings.set']({
          project,
          settings: {
            ...read,
            concurrent: 4,
            verifier: { ...read.verifier, rounds: 5 },
            shared_files: ['docs/**'],
          },
        })
        expect(readFileSync(file, 'utf8')).toBe(
          '{\n    "concurrent": 4,\n    "check_timeout": "45m",\n    "verifier": { "rounds": 5 },\n    "shared_files": [\n        "docs/**"\n    ]\n}\n',
        )
        const again = yield* client['projects.settings.get']({ project })
        expect(again.concurrent).toBe(4)
        expect(again.shared_files).toStrictEqual(['docs/**'])
        const [info] = yield* client['projects.list']()
        expect(info?.setUp).toBe(true)
      }).pipe(Effect.scoped),
  )

  it.live('removes the keys a set finds that are no settings', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client } = yield* newEngine
      const { id: project } = yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      const file = NodePath.join(repo.work, '.fabrica', 'settings.json')
      writeFileSync(file, '{ "concurrent": 3 }\n')
      const settings = yield* client['projects.settings.get']({ project })
      writeFileSync(file, '{ "concurrent": 3, "colour": "red" }\n')
      yield* client['projects.settings.set']({ project, settings })
      expect(readFileSync(file, 'utf8')).toBe('{ "concurrent": 3 }\n')

      const missing = ProjectId.make('missing')
      expect(
        failureOf(
          yield* Effect.exit(
            client['projects.settings.get']({ project: missing }),
          ),
        ),
      ).toStrictEqual(new ProjectNotFound({ project: missing }))
    }).pipe(Effect.scoped),
  )

  it.live('answers a settings file that doesn’t decode as a defect', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const { client } = yield* newEngine
      const { id: project } = yield* client['projects.add']({
        source: pathSource(repo.work),
        name: Option.none(),
      })
      writeFileSync(
        NodePath.join(repo.work, '.fabrica', 'settings.json'),
        '{ "concurrent": 3, "colour": "red" }\n',
      )
      // The test server ends at a defect, so this request is the test's last.
      const exit = yield* Effect.exit(
        client['projects.settings.get']({ project }),
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live(
    'opens each project’s work graph on its work.db, with the prefix its name gives',
    () =>
      Effect.gen(function* () {
        const repo = yield* newRepo
        const { client, projects } = yield* newEngine
        const { id: project } = yield* client['projects.add']({
          source: pathSource(repo.work),
          name: Option.some('fabrica'),
        })
        const graph = yield* projects.workGraph(project)
        const ticket = yield* graph.create({
          ticket: { type: 'task', title: 'A ticket' },
          actor: maintainer,
        })
        expect(ticket.id).toMatch(/^fab-/u)
        expect(yield* projects.workGraph(project)).toBe(graph)
      }).pipe(Effect.scoped),
  )

  it.live(
    'streams the rows, a patch for each change, and resumes after the last',
    () =>
      Effect.gen(function* () {
        const repo = yield* newRepo
        const { client, projects } = yield* newEngine
        const items = yield* Queue.unbounded<ProjectStatusItem>()
        yield* client['projects.watchStatus']({ resume: Option.none() }).pipe(
          Stream.runForEach(item => Queue.offer(items, item)),
          Effect.forkScoped,
        )
        const snapshot = yield* Queue.take(items)
        const { id: project } = yield* client['projects.add']({
          source: pathSource(repo.work),
          name: Option.none(),
        })
        const graph = yield* projects.workGraph(project)
        yield* graph.create({
          ticket: { type: 'task', title: 'Ready' },
          actor: maintainer,
        })
        const added = yield* Queue.take(items)
        const ready = yield* Queue.take(items)
        yield* client['projects.remove']({ project })
        const removed = yield* Queue.take(items)

        if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
        expect(snapshot.value).toStrictEqual([])
        if (added?._tag !== 'patch' || ready?._tag !== 'patch')
          return expect.fail('no patches')
        expect(added.seq).toBe(snapshot.seq + 1)
        expect(
          added.value.upsert.map(row => [row.project, row.ready]),
        ).toStrictEqual([[project, 0]])
        expect(
          ready.value.upsert.map(row => [row.project, row.ready]),
        ).toStrictEqual([[project, 1]])
        expect(ready.value.upsert[0]?.run._tag).toBe('idle')
        expect(removed).toStrictEqual({
          _tag: 'patch',
          seq: snapshot.seq + 3,
          value: { upsert: [], remove: [project] },
        })

        // A client that took the snapshot and the first patch gets the rest; one of another epoch, a snapshot.
        const resumed = yield* client['projects.watchStatus']({
          resume: Option.some(
            new Resume({ epoch: snapshot.epoch, after: added.seq }),
          ),
        }).pipe(Stream.take(2), Stream.runCollect)
        expect(resumed).toStrictEqual([ready, removed])
        const [fresh] = yield* client['projects.watchStatus']({
          resume: Option.some(
            new Resume({ epoch: StreamEpoch.make('another'), after: 1 }),
          ),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(fresh?._tag).toBe('snapshot')
      }).pipe(Effect.scoped),
  )

  it.live('opens its projects again when the engine starts again', () =>
    Effect.gen(function* () {
      const repo = yield* newRepo
      const data = yield* tempFolder('projects-restart')
      const database = NodePath.join(data, 'engine.db')
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client, projects } = yield* engineAt({ data, database })
          const added = yield* client['projects.add']({
            source: pathSource(repo.work),
            name: Option.none(),
          })
          const graph = yield* projects.workGraph(added.id)
          yield* graph.create({
            ticket: { type: 'task', title: 'Kept' },
            actor: maintainer,
          })
          return added
        }),
      )
      const { client } = yield* engineAt({ data, database })
      expect(yield* client['projects.list']()).toStrictEqual([first])
      const [snapshot] = yield* client['projects.watchStatus']({
        resume: Option.none(),
      }).pipe(Stream.take(1), Stream.runCollect)
      if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
      expect(snapshot.value.map(row => [row.project, row.ready])).toStrictEqual(
        [[first.id, 1]],
      )
    }).pipe(Effect.scoped),
  )

  it('writes the .gitignore init commits with the same entries', () => {
    expect(
      fabricaIgnoreText
        .split('\n')
        .filter(line => line !== '' && !line.startsWith('#')),
    ).toStrictEqual(
      excludedEntries.map(entry => entry.replace('/.fabrica/', '')),
    )
  })
})
