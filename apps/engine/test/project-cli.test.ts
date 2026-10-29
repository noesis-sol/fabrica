import { Console, Duration, Effect, Exit, Layer, Option, Schema } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { EngineHost, ProjectInfo, ProjectSource } from '@fabrica/contracts'
import { Daemon, Git, Process } from '@fabrica/engine'
import {
  Toolbox,
  type Tools,
  layerHost,
  layerToolbox,
  makeGitRepo,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { projectSource } from '../src/cli/project'

// `fabrica project add|list|remove` (spec §19, §10.1): run as the CLI's entry runs it, against an
// engine started in a temporary data folder, its git given the test's toolbox, on a checkout and the
// bare repository it pushed to.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** The engine's git, run with the toolbox's PATH and home. */
const gitOf = (tools: Tools) =>
  Git.layer({
    timeLimit: Duration.minutes(1),
    readRetries: { times: 0, spacing: Duration.zero },
  }).pipe(
    Layer.provide(
      Process.layer({
        hostEnvironment: tools.env(),
        enginePriority: 0,
        priority: Process.hostPriority,
        listProcesses: Process.listProcesses,
        pipeHolders: Process.hostHolders({
          platform: process.platform,
          self: process.pid,
        }),
        self: process.pid,
        killGrace: Duration.seconds(2),
        outputGrace: Duration.millis(200),
      }),
    ),
    Layer.provide(Process.layerClock),
  )

/** An engine started in a temporary data folder, for the test's scope. */
const testEngine = Effect.gen(function* () {
  const tools = yield* Toolbox
  const root = yield* tempFolder('cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    git: gitOf(tools),
  })
  return { socket: paths.socket, data: paths.data }
})

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(' ')),
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

const decodeInfo = Schema.decodeUnknownSync(ProjectInfo)
const decodeInfos = Schema.decodeUnknownSync(Schema.Array(ProjectInfo))

/** The one line of JSON a command printed. */
const onlyJson = (out: ReadonlyArray<string>): unknown => {
  expect(out).toHaveLength(1)
  return JSON.parse(out[0] ?? '')
}

describe('projectSource', () => {
  const table: ReadonlyArray<readonly [given: string, source: ProjectSource]> =
    [
      [
        'https://host.test/team/app.git',
        ProjectSource.cases.url.make({ url: 'https://host.test/team/app.git' }),
      ],
      [
        'file:///srv/app.git',
        ProjectSource.cases.url.make({ url: 'file:///srv/app.git' }),
      ],
      [
        'git@host.test:team/app.git',
        ProjectSource.cases.url.make({ url: 'git@host.test:team/app.git' }),
      ],
      ['/src/app/', ProjectSource.cases.path.make({ path: '/src/app' })],
    ]
  it.each(table)('reads %s', (given, source) => {
    expect(projectSource(given)).toStrictEqual(source)
  })
})

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica project',
  it => {
    it.effect('adds a checkout and a clone, lists them and removes them', () =>
      Effect.gen(function* () {
        const repo = yield* makeGitRepo(yield* Toolbox)
        const { socket, data } = yield* testEngine

        const registered = yield* fabrica(
          socket,
          'project',
          'add',
          repo.work,
          '--json',
        )
        expect(registered.exit).toStrictEqual(Exit.void)
        const checkout = decodeInfo(onlyJson(registered.out))
        expect(checkout.id).toBe('work')
        expect(checkout.path).toBe(repo.work)
        expect(checkout.origin).toBe('registered')
        expect(checkout.setUp).toBe(false)

        const cloned = yield* fabrica(
          socket,
          'project',
          'add',
          `file://${repo.remote}`,
          '--name',
          'Clone',
        )
        expect(cloned.exit).toStrictEqual(Exit.void)
        const clonePath = NodePath.join(data, 'projects', 'clone', 'repo')
        expect(cloned.out.join('\n')).toBe(
          [
            'project  clone',
            'name     Clone',
            `path     ${clonePath}`,
            `origin   cloned from file://${repo.remote}`,
            'base     main',
            'set up   no: it has no .fabrica/settings.json yet; set it up with `fabrica init`',
          ].join('\n'),
        )

        const listed = yield* fabrica(socket, 'project', 'list', '--json')
        expect(
          decodeInfos(onlyJson(listed.out)).map(({ id, url }) => [id, url]),
        ).toStrictEqual([
          ['work', Option.none()],
          ['clone', Option.some(`file://${repo.remote}`)],
        ])
        const text = yield* fabrica(socket, 'project', 'list')
        expect(text.out.join('\n')).toBe(
          [
            `work   main  not set up  ${repo.work}`,
            `clone  main  not set up  ${clonePath}`,
          ].join('\n'),
        )

        const removed = yield* fabrica(
          socket,
          'project',
          'remove',
          'work',
          '--json',
        )
        expect(removed.exit).toStrictEqual(Exit.void)
        expect(onlyJson(removed.out)).toStrictEqual({ removed: 'work' })
        yield* fabrica(socket, 'project', 'remove', 'clone')
        const none = yield* fabrica(socket, 'project', 'list')
        expect(none.out).toStrictEqual([
          'no projects: add one with `fabrica project add <path|url>`',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('says why a project couldn’t be added or removed', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const { socket } = yield* testEngine
        const notACheckout = yield* fabrica(
          socket,
          'project',
          'add',
          tools.home,
        )
        expect(Exit.isFailure(notACheckout.exit)).toBe(true)
        expect(notACheckout.err).toStrictEqual([
          `fabrica: the project couldn't be added: ${tools.home} is not in a git checkout`,
        ])

        const unknown = yield* fabrica(socket, 'project', 'remove', 'nothing')
        expect(Exit.isFailure(unknown.exit)).toBe(true)
        expect(unknown.err).toStrictEqual([
          'fabrica: the engine has no project nothing',
        ])
      }).pipe(Effect.scoped),
    )
  },
)
