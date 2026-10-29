import { Console, Duration, Effect, Exit, Layer } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { expect } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon, Git, Process } from '@fabrica/engine'
import {
  Toolbox,
  type Tools,
  layerHost,
  makeGitRepo,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'

// The `fabrica tickets` tests' engine: started in a temporary data folder with one project, a
// checkout of the test's, and the CLI run as its entry runs it, against it.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** The engine's git, run with the toolbox's PATH and home. */
export const gitOf = (tools: Tools) =>
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

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
export const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
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

/** An engine started in a temporary data folder with one project, `work`, for the test's scope. */
export const testEngine = Effect.gen(function* () {
  const tools = yield* Toolbox
  const root = yield* tempFolder('tickets-cli')
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
  const repo = yield* makeGitRepo(tools)
  const added = yield* fabrica(paths.socket, 'project', 'add', repo.work)
  expect(added.exit).toStrictEqual(Exit.void)
  /** `fabrica tickets <args> --project work`. */
  const tickets = (...args: ReadonlyArray<string>) =>
    fabrica(paths.socket, 'tickets', ...args, '--project', 'work')
  return { socket: paths.socket, tickets }
})

/** The one line of JSON a command printed. */
export const onlyJson = (out: ReadonlyArray<string>): unknown => {
  expect(out).toHaveLength(1)
  return JSON.parse(out[0] ?? '')
}
