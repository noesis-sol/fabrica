import { Cause, Duration, Effect, Exit, Layer, Option } from 'effect'
import { RpcTest } from 'effect/rpc'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { FolderUnreadable, ProjectRpcs } from '@fabrica/contracts'

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
import { listFolders, layer as projectsLayer } from '../src/projects'
import { projectsHandlers } from '../src/rpc/projects'

// Browsing the engine host's folders for a checkout to add (spec §10.1): a folder's subfolders by
// name, hidden ones, files and broken links left out, a link to a folder listed, each marked where it
// holds `.git`; the folder above it, none at the root. A folder that isn't there, a file and a
// relative path are refused, saying which. Over the protocol, a request without a path lists the
// engine's home folder.

let root = ''
let home = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-folders-')))
  home = NodePath.join(root, 'home')
  mkdirSync(home)
})

/** A folder of its own: `src/` with a checkout, a worktree, plain folders, a hidden one, a file and links. */
const newTree = () => {
  const top = mkdtempSync(NodePath.join(root, 'tree-'))
  const src = NodePath.join(top, 'src')
  mkdirSync(NodePath.join(src, 'app', '.git'), { recursive: true })
  mkdirSync(NodePath.join(src, 'worktree'))
  writeFileSync(
    NodePath.join(src, 'worktree', '.git'),
    'gitdir: /elsewhere/.git/worktrees/worktree\n',
  )
  mkdirSync(NodePath.join(src, 'notes', 'deeper'), { recursive: true })
  mkdirSync(NodePath.join(src, '.cache'))
  writeFileSync(NodePath.join(src, 'README.md'), '# src\n')
  symlinkSync(NodePath.join(src, 'app'), NodePath.join(src, 'linked'))
  symlinkSync(NodePath.join(top, 'gone'), NodePath.join(src, 'broken'))
  return { top, src }
}

const refusal = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isSuccess(exit) ? Option.none() : Cause.findErrorOption(exit.cause)

describe('the host’s folders', () => {
  it.effect(
    'lists the subfolders by name, marking the checkouts, with the folder above',
    () =>
      Effect.gen(function* () {
        const { top, src } = newTree()
        const listing = yield* listFolders(src)
        expect(listing.path).toBe(src)
        expect(listing.parent).toStrictEqual(Option.some(top))
        expect(listing.checkout).toBe(false)
        expect(
          listing.folders.map(({ name, path, checkout }) => ({
            name,
            path,
            checkout,
          })),
        ).toStrictEqual([
          { name: 'app', path: NodePath.join(src, 'app'), checkout: true },
          {
            name: 'linked',
            path: NodePath.join(src, 'linked'),
            checkout: true,
          },
          { name: 'notes', path: NodePath.join(src, 'notes'), checkout: false },
          {
            name: 'worktree',
            path: NodePath.join(src, 'worktree'),
            checkout: true,
          },
        ])
      }),
  )

  it.effect('marks the folder listed where it is a checkout itself', () =>
    Effect.gen(function* () {
      const { src } = newTree()
      const listing = yield* listFolders(NodePath.join(src, 'app'))
      expect(listing.checkout).toBe(true)
      expect(listing.folders).toStrictEqual([])
    }),
  )

  it.effect('lists the folder a path through `..` or ending in / names', () =>
    Effect.gen(function* () {
      const { src } = newTree()
      const listing = yield* listFolders(`${src}/notes/../notes/`)
      expect(listing.path).toBe(NodePath.join(src, 'notes'))
      expect(listing.folders.map(({ name }) => name)).toStrictEqual(['deeper'])
    }),
  )

  it.effect('has nothing above the root', () =>
    Effect.gen(function* () {
      const listing = yield* listFolders('/')
      expect(listing.path).toBe('/')
      expect(listing.parent).toStrictEqual(Option.none())
    }),
  )

  it.effect(
    'refuses a folder that isn’t there, a file and a relative path',
    () =>
      Effect.gen(function* () {
        const { src } = newTree()
        const missing = NodePath.join(src, 'missing')
        const file = NodePath.join(src, 'README.md')
        const refused = yield* Effect.all(
          [missing, file, 'src/app'].map(path =>
            Effect.exit(listFolders(path)).pipe(Effect.map(refusal)),
          ),
        )
        expect(refused).toStrictEqual([
          Option.some(
            new FolderUnreadable({
              path: missing,
              reason: `there is no folder at ${missing}`,
            }),
          ),
          Option.some(
            new FolderUnreadable({
              path: file,
              reason: `${file} is not a folder`,
            }),
          ),
          Option.some(
            new FolderUnreadable({
              path: 'src/app',
              reason: 'src/app is not an absolute path',
            }),
          ),
        ])
      }),
  )
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

/** The Projects group's client, on an engine whose host's home folder is `home`. */
const newClient = Effect.gen(function* () {
  const data = mkdtempSync(NodePath.join(root, 'data-'))
  const services = yield* Layer.build(
    projectsHandlers.pipe(
      Layer.provide(projectsLayer),
      Layer.provide(
        layerHostFrom({
          availableParallelism: () => 2,
          totalmem: () => 8 * 1024 ** 3,
          loadavg: () => [0],
          homedir: () => home,
        }),
      ),
      Layer.provide(
        gitLayer(gitConfig).pipe(
          Layer.provide(runnerLayer(runnerConfig())),
          Layer.provide(layerClock),
        ),
      ),
      Layer.provide(engineDatabaseLayer(':memory:')),
      Layer.provide(
        Layer.succeed(EngineFiles)(pathsIn({ data, socketFolder: data })),
      ),
    ),
  )
  return yield* RpcTest.makeClient(ProjectRpcs).pipe(Effect.provide(services))
})

describe('projects.folders', () => {
  it.live('lists the engine’s home folder where no path is given', () =>
    Effect.gen(function* () {
      mkdirSync(NodePath.join(home, 'src'), { recursive: true })
      const client = yield* newClient
      const listing = yield* client['projects.folders']({
        path: Option.none(),
      })
      expect(listing.path).toBe(home)
      expect(listing.parent).toStrictEqual(Option.some(root))
      expect(listing.folders.map(({ name }) => name)).toStrictEqual(['src'])
    }).pipe(Effect.scoped),
  )

  it.live('lists the path given, and refuses one that isn’t a folder', () =>
    Effect.gen(function* () {
      const { src } = newTree()
      const client = yield* newClient
      const listing = yield* client['projects.folders']({
        path: Option.some(src),
      })
      expect(listing.folders.map(({ name }) => name)).toStrictEqual([
        'app',
        'linked',
        'notes',
        'worktree',
      ])
      const missing = NodePath.join(src, 'missing')
      const exit = yield* client['projects.folders']({
        path: Option.some(missing),
      }).pipe(Effect.exit)
      expect(refusal(exit)).toStrictEqual(
        Option.some(
          new FolderUnreadable({
            path: missing,
            reason: `there is no folder at ${missing}`,
          }),
        ),
      )
    }).pipe(Effect.scoped),
  )
})
