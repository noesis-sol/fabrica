import { Console, Effect, Exit, Layer, Option, Ref } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon, Update } from '@fabrica/engine'
import { layerHost, tempFolder } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'

// `fabrica engine update [<version>]` (spec §19, §9.2): the engine asked to install the latest release or
// the one named and restart into it, against an engine whose Updater the test plays; what it answers
// printed as text or JSON, sanitised, and a refusal said in words.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 8,
})
const release = '1.2.3'
const launcher = '/home/test/.local/share/fabrica/engine/1.3.0/bin/fabrica'

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...line: ReadonlyArray<unknown>) => out.push(line.join(' ')),
        error: (...line: ReadonlyArray<unknown>) => err.push(line.join(' ')),
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

/** An engine whose Updater answers `install` and keeps the releases it was asked for. */
const engineUpdating = (
  install: Effect.Effect<Update.Installed, Update.UpdateFailure>,
) =>
  Effect.gen(function* () {
    const root = yield* tempFolder('cli-update')
    const paths = Daemon.pathsIn({
      data: NodePath.join(root, 'd'),
      socketFolder: NodePath.join(root, 'd'),
    })
    const asked = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
    const engine = yield* Daemon.startEngine({
      paths,
      host,
      release,
      update: Layer.succeed(
        Update.Updater,
        Update.Updater.of({
          install: request =>
            Ref.update(asked, all => [...all, request.release]).pipe(
              Effect.andThen(install),
            ),
        }),
      ),
    })
    return { socket: paths.socket, engine, asked }
  })

const installed = Effect.succeed({ version: '1.3.0', launcher })

describe('fabrica engine update', () => {
  it.live('updates to the latest release, saying so as JSON', () =>
    Effect.gen(function* () {
      const { socket, engine, asked } = yield* engineUpdating(installed)
      const { exit, out } = yield* fabrica(socket, 'engine', 'update', '--json')
      expect(exit).toStrictEqual(Exit.void)
      expect(out).toHaveLength(1)
      expect(JSON.parse(out[0] ?? '')).toStrictEqual({
        from: '1.2.3',
        to: '1.3.0',
      })
      expect(yield* Ref.get(asked)).toStrictEqual([Option.none()])
      expect(yield* engine.stopRequested).toStrictEqual(
        Daemon.EngineEnd.Restart({ launcher }),
      )
    }).pipe(Effect.scoped),
  )

  it.live('updates to the release named, saying so as text', () =>
    Effect.gen(function* () {
      const { socket, asked } = yield* engineUpdating(installed)
      const { exit, out } = yield* fabrica(socket, 'engine', 'update', '1.3.0')
      expect(exit).toStrictEqual(Exit.void)
      expect(out).toStrictEqual([
        'the engine installed 1.3.0, and restarts into it from 1.2.3 once its runs are wound down',
      ])
      expect(yield* Ref.get(asked)).toStrictEqual([Option.some('1.3.0')])
    }).pipe(Effect.scoped),
  )

  it.live('refuses what isn’t a release, asking the engine nothing', () =>
    Effect.gen(function* () {
      const { socket, asked } = yield* engineUpdating(installed)
      const { exit } = yield* fabrica(socket, 'engine', 'update', 'latest')
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* Ref.get(asked)).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('says why the engine wasn’t updated, the reason escaped', () =>
    Effect.gen(function* () {
      const { socket, engine } = yield* engineUpdating(
        Effect.fail(
          Update.UpdateFailure.DownloadFailed({
            url: 'https://x.test/\u001b[2Jchecksums.txt',
            message: 'refused',
          }),
        ),
      )
      const { exit, out, err } = yield* fabrica(socket, 'engine', 'update')
      expect(Exit.isFailure(exit)).toBe(true)
      expect(out).toStrictEqual([])
      expect(err).toStrictEqual([
        "fabrica: the engine wasn't updated: cannot download https://x.test/\\u001b[2Jchecksums.txt: refused",
      ])
      expect(yield* engine.stopping).toBe(false)
    }).pipe(Effect.scoped),
  )
})
