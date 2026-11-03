import { Effect, Exit } from 'effect'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'

import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from '../../../packages/engine/test/scripted-run'
import { fabricaIn } from './tickets-engine'

// `fabrica run` sends the FABRICA_ variables of settings in its own environment with its flags
// (spec §13.13): the engine resolves them, a flag over its variable, so a variable's problem refuses
// the start naming it, and `FABRICA_AUTO_ANSWER` starts the run answering as `--auto-answer` does.

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

/** A test engine with one project, `work`, on a new checkout, and `fabrica … --project work` against it. */
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
  const added = yield* fabricaIn(
    {},
    paths.socket,
    'project',
    'add',
    checkout,
    '--name',
    'work',
  )
  expect(added.exit).toStrictEqual(Exit.void)
  /** `fabrica <args> --project work`, run in `environment`. */
  const command = (
    environment: Readonly<Record<string, string>>,
    ...args: ReadonlyArray<string>
  ) => fabricaIn(environment, paths.socket, ...args, '--project', 'work')
  return { command }
})

describe("fabrica run's FABRICA_ variables", () => {
  it.live(
    "a variable's problem refuses the start, named by the variable; a flag is taken over its variable",
    () =>
      Effect.gen(function* () {
        const { command } = yield* runEngine
        const variable = yield* command({ FABRICA_CONCURRENT: 'lots' }, 'run')
        expect(variable.exit._tag).toBe('Failure')
        expect(variable.err.join('\n')).toContain(
          '  FABRICA_CONCURRENT concurrent: ',
        )
        expect(variable.err.at(-1)).toBe(
          "fabrica: the run didn't start (SETUP)",
        )

        const flag = yield* command(
          { FABRICA_CONCURRENT: 'lots' },
          'run',
          '--concurrent',
          '0',
        )
        expect(flag.err.join('\n')).toContain('  --concurrent concurrent: ')
        expect(flag.err.join('\n')).not.toContain('FABRICA_CONCURRENT')
      }).pipe(Effect.scoped),
  )

  it.live(
    'FABRICA_AUTO_ANSWER starts the run answering, as --auto-answer does',
    () =>
      Effect.gen(function* () {
        const { command } = yield* runEngine
        const filed = yield* command(
          {},
          'tickets',
          'create',
          'Never done',
          '--description',
          'stub: hang',
        )
        expect(filed.exit).toStrictEqual(Exit.void)
        const started = yield* command({ FABRICA_AUTO_ANSWER: 'true' }, 'run')
        expect(started.exit).toStrictEqual(Exit.void)

        const status = yield* command({}, 'run', 'status', '--json')
        expect(JSON.parse(status.out.join('\n'))).toMatchObject({
          _tag: 'going',
          header: { autoAnswer: true },
        })

        const stopped = yield* command({}, 'run', 'stop')
        expect(stopped.exit).toStrictEqual(Exit.void)
      }).pipe(Effect.scoped),
  )
})
