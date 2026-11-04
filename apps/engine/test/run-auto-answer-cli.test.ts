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

// `fabrica run --auto-answer[=<duration>]` (spec §15.2, §19): a settings flag, given bare or with a
// duration, starting the run answering; a value it can't read refuses the start, naming the flag.

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

/** A test engine with one project, `work`, on a new checkout, with a ticket that works until stopped. */
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
  const added = yield* fabricaIn(
    {},
    paths.socket,
    'project',
    'add',
    makeCheckout(places),
    '--name',
    'work',
  )
  expect(added.exit).toStrictEqual(Exit.void)
  /** `fabrica <args> --project work`. */
  const command = (...args: ReadonlyArray<string>) =>
    fabricaIn({}, paths.socket, ...args, '--project', 'work')
  const filed = yield* command(
    'tickets',
    'create',
    'Never done',
    '--description',
    'stub: hang',
  )
  expect(filed.exit).toStrictEqual(Exit.void)
  return { command }
})

describe('fabrica run --auto-answer', () => {
  it.live.each([
    ['bare', '--auto-answer'],
    ['with a duration', '--auto-answer=10m'],
  ])('%s starts the run answering', ([, flag]) =>
    Effect.gen(function* () {
      const { command } = yield* runEngine
      const started = yield* command('run', flag)
      expect(started.exit).toStrictEqual(Exit.void)

      const status = yield* command('run', 'status', '--json')
      expect(JSON.parse(status.out.join('\n'))).toMatchObject({
        _tag: 'going',
        header: { autoAnswer: true },
      })

      const stopped = yield* command('run', 'stop')
      expect(stopped.exit).toStrictEqual(Exit.void)
    }).pipe(Effect.scoped),
  )

  it.live("a value it can't read refuses the start, naming the flag", () =>
    Effect.gen(function* () {
      const { command } = yield* runEngine
      const started = yield* command('run', '--auto-answer=later')
      expect(Exit.isFailure(started.exit)).toBe(true)
      expect(started.err.join('\n')).toContain('--auto-answer')
    }).pipe(Effect.scoped),
  )
})
