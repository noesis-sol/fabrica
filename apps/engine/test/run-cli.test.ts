import {
  Cause,
  Console,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Runtime,
} from 'effect'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import { layerHost } from '@fabrica/testkit'

import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from '../../../packages/engine/test/scripted-run'
import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { fabrica } from './tickets-engine'

// `fabrica run` and `fabrica follow` (spec §19, §13.10, §13.11): run as the CLI's entry runs it,
// against a test engine whose runs are on a scripted agent, with one project, `work`, on a real
// checkout. `run --wait` prints the run's lines and exits with its end's code: 0 after a merge, 130
// once `run stop` has stopped it; `follow` prints the run's lines until it ends; a start the engine
// refuses prints its problems and exits 2.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** A test engine with one project, `work`, on a new checkout: its socket, and `fabrica` against it. */
const runEngine = Effect.gen(function* () {
  const data = yield* Effect.promise(() =>
    mkdtemp(NodePath.join(places.root, 'e')),
  )
  const paths = Daemon.pathsIn({ data, socketFolder: data })
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    runs: scriptedHosting(places, data),
  })
  const checkout = makeCheckout(places)
  const added = yield* fabrica(
    paths.socket,
    'project',
    'add',
    checkout,
    '--name',
    'work',
  )
  expect(added.exit).toStrictEqual(Exit.void)
  /** `fabrica <args> --project work`. */
  const command = (...args: ReadonlyArray<string>) =>
    fabrica(paths.socket, ...args, '--project', 'work')
  /** Files a task whose stub does `script`. */
  const file = (title: string, script: string) =>
    command('tickets', 'create', title, '--description', `stub: ${script}`)
  return { socket: paths.socket, checkout, command, file }
})

/**
 * `fabrica <args> --project work`, its printed lines given as they come: `line` waits for the first
 * that holds `text`; `exit` for the command's end, with everything it printed.
 */
const live = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>()
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => {
          const line = parts.join(' ')
          out.push(line)
          Queue.offerUnsafe(lines, line)
        },
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const fiber = yield* runCli([...args, '--project', 'work']).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
      Effect.forkScoped,
    )
    const line = (text: string) =>
      Effect.gen(function* () {
        while (true) {
          const next = yield* Queue.take(lines)
          if (next.includes(text)) return next
        }
      })
    const exit = Effect.map(Fiber.join(fiber), done => ({
      exit: done,
      out,
      err,
    }))
    return { line, exit }
  })

/** The exit code a command's exit gives: 0 for a success, else its error's (1 unless it says). */
const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit)
    ? 0
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => 1,
        onSome: Runtime.getErrorExitCode,
      })

describe('fabrica run and follow', () => {
  it.live(
    '`run --wait` prints the run’s lines and exits 0 after its ticket merges',
    () =>
      Effect.gen(function* () {
        const { command, file } = yield* runEngine
        yield* file('Add the page', 'finish')
        const { exit, out } = yield* command('run', '--wait')
        expect(exitCodeOf(exit)).toBe(0)
        const printed = out.join('\n')
        expect(printed).toMatch(/^\d\d:\d\d:\d\d .*Add the page/mu)
        expect(printed).toContain('merged')
        expect(out.at(-1)).toMatch(/READY_EMPTY after 1 ticket$/u)

        const status = yield* command('run', 'status')
        expect(status.out.join('\n')).toMatch(
          /^no run is going; the last, .*, ended READY_EMPTY at /u,
        )
      }).pipe(Effect.scoped),
  )

  it.live('`follow` prints the going run’s lines until it ends', () =>
    Effect.gen(function* () {
      const { socket, command, file } = yield* runEngine
      const go = NodePath.join(places.root, `go-follow-${Date.now()}`)
      yield* file('Wait for it', `wait ${go}`)
      const started = yield* command('run')
      expect(started.exit).toStrictEqual(Exit.void)
      expect(started.out.join('\n')).toMatch(/^started the run /u)

      const following = yield* live(socket, 'follow')
      yield* following.line('Wait for it')
      writeFileSync(go, '')
      const { exit, out } = yield* following.exit
      expect(exit).toStrictEqual(Exit.void)
      expect(out.join('\n')).toContain('merged')
      expect(out.at(-1)).toMatch(/READY_EMPTY after 1 ticket$/u)

      const json = yield* command('run', 'status', '--json')
      expect(JSON.parse(json.out.join(''))).toMatchObject({ _tag: 'idle' })
    }).pipe(Effect.scoped),
  )

  it.live('`run stop` ends a waited run, which exits 130', () =>
    Effect.gen(function* () {
      const { socket, command, file } = yield* runEngine
      yield* file('Never done', 'hang')
      const waiting = yield* live(socket, 'run', '--wait')
      yield* waiting.line('Never done')

      const going = yield* command('run', 'status')
      expect(going.out.join('\n')).toMatch(/^state {4}running$/mu)
      const stopped = yield* command('run', 'stop')
      expect(stopped.exit).toStrictEqual(Exit.void)
      expect(stopped.out).toStrictEqual([
        'the run of work stops: its workers are interrupted, their sessions saved',
      ])

      const { exit, out, err } = yield* waiting.exit
      expect(exitCodeOf(exit)).toBe(130)
      expect(out.join('\n')).toContain('INTERRUPTED')
      expect(err.at(-1)).toMatch(/ended with exit code 130$/u)

      const again = yield* command('run', 'stop')
      expect(exitCodeOf(again.exit)).toBe(1)
      expect(again.err).toStrictEqual([
        'fabrica: no run is going in the project: start one with `fabrica run`',
      ])
    }).pipe(Effect.scoped),
  )

  it.live(
    'a refused start prints its problems and exits 2; flags it can’t take are refused',
    () =>
      Effect.gen(function* () {
        const { checkout, command } = yield* runEngine
        writeFileSync(NodePath.join(checkout, 'README.md'), 'changed\n')
        const dirty = yield* command('run')
        expect(exitCodeOf(dirty.exit)).toBe(2)
        expect(dirty.err.join('\n')).toContain('uncommitted changes: README.md')
        expect(dirty.err.at(-1)).toBe("fabrica: the run didn't start (SETUP)")

        const both = yield* command('run', '--tickets', '--overnight')
        expect(exitCodeOf(both.exit)).toBe(1)
        expect(both.err.at(-1)).toContain('give one mode at most')

        const refine = yield* command('run', '--refine')
        expect(refine.err.at(-1)).toBe(
          'fabrica: --refine refines a spec: give it with --spec',
        )

        const follow = yield* command('follow')
        expect(follow.err).toStrictEqual([
          'fabrica: no run is going in work: start one with `fabrica run`',
        ])
      }).pipe(Effect.scoped),
  )
})
