import { Cause, Effect, Exit, Option, Runtime } from 'effect'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon, Requirements } from '@fabrica/engine'

import {
  type ScriptedPlaces,
  engineGit,
  fixtureEnvironment,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from '../../../packages/engine/test/scripted-run'
import { fabrica, onlyJson } from './tickets-engine'

// `fabrica requires [--markdown]` (spec §19, §17): run as the CLI's entry runs it, against a test engine
// whose runs are on a scripted agent, with one project, `work`, on a real checkout whose list is the
// test's. The command says each entry's state as the engine finds it, and exits 2 for one missing.

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

/** A test engine with the project `work`, whose list on Base is `requires`. */
const engineWith = (requires: ReadonlyArray<object>) =>
  Effect.gen(function* () {
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
    const checkout = makeCheckout(places, { ...scriptedSettings, requires })
    const added = yield* fabrica(
      paths.socket,
      'project',
      'add',
      checkout,
      '--name',
      'work',
    )
    expect(added.exit).toStrictEqual(Exit.void)
    const command = (...args: ReadonlyArray<string>) =>
      fabrica(paths.socket, ...args, '--project', 'work')
    return { checkout, command }
  })

/** Runs git in `checkout`, as the fixture does. */
const gitIn =
  (checkout: string) =>
  (...args: ReadonlyArray<string>) =>
    execFileSync('git', args, {
      cwd: checkout,
      stdio: 'ignore',
      env: fixtureEnvironment(places),
    })

const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit)
    ? 0
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => 1,
        onSome: Runtime.getErrorExitCode,
      })

describe('fabrica requires', () => {
  it.live('says each entry’s state, and an install’s having met it', () =>
    Effect.gen(function* () {
      const { checkout, command } = yield* engineWith([
        { name: 'met', check: 'true', manual: 'never asked' },
        { name: 'tool', check: 'test -f tool', install: 'touch tool' },
        {
          name: 'elsewhere',
          check: 'false',
          manual: 'never asked',
          platforms: ['win32'],
        },
      ])
      const { exit, out } = yield* command('requires')
      expect(exit).toStrictEqual(Exit.void)
      expect(out.join('\n').split('\n')).toEqual([
        'met: met',
        'tool: installed with `touch tool`',
        'elsewhere: not checked: only on win32',
      ])
      expect(existsSync(NodePath.join(checkout, 'tool'))).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live(
    'exits 2 for one missing, each with its instruction; --json too',
    () =>
      Effect.gen(function* () {
        const { command } = yield* engineWith([
          { name: 'docker', check: 'false', manual: 'start Docker Desktop' },
        ])
        const text = yield* command('requires')
        expect(exitCodeOf(text.exit)).toBe(2)
        expect(text.out).toEqual(['docker: missing: start Docker Desktop'])
        expect(text.err.at(-1)).toBe('fabrica: requirements are missing')
        const json = yield* command('requires', '--json')
        expect(exitCodeOf(json.exit)).toBe(2)
        expect(onlyJson(json.out)).toEqual([
          {
            name: 'docker',
            state: { _tag: 'missing', instruction: 'start Docker Desktop' },
          },
        ])
      }).pipe(Effect.scoped),
  )

  it.live('says so of an empty list', () =>
    Effect.gen(function* () {
      const { command } = yield* engineWith([])
      const { exit, out } = yield* command('requires')
      expect(exit).toStrictEqual(Exit.void)
      expect(out).toEqual(['the requires list is empty'])
    }).pipe(Effect.scoped),
  )

  it.live(
    'refuses a checkout off Base or with uncommitted changes, running nothing: a command there would run its scripts',
    () =>
      Effect.gen(function* () {
        const { checkout, command } = yield* engineWith([
          { name: 'on-base', check: 'touch on-base', manual: 'never asked' },
        ])
        const git = gitIn(checkout)
        writeFileSync(NodePath.join(checkout, 'README.md'), 'changed\n')
        const dirty = yield* command('requires')
        expect(exitCodeOf(dirty.exit)).toBe(1)
        expect(dirty.err.join('\n')).toContain(
          "has uncommitted changes, and the list's commands run there: README.md",
        )
        git('checkout', '--quiet', '--', 'README.md')
        git('checkout', '--quiet', '-b', 'feature')
        const offBase = yield* command('requires')
        expect(exitCodeOf(offBase.exit)).toBe(1)
        expect(offBase.err.join('\n')).toContain("isn't on main")
        expect(existsSync(NodePath.join(checkout, 'on-base'))).toBe(false)
        git('checkout', '--quiet', 'main')
        const { exit, out } = yield* command('requires')
        expect(exit).toStrictEqual(Exit.void)
        expect(out).toEqual(['on-base: met'])
      }).pipe(Effect.scoped),
  )

  it.live('runs Base’s list alone, never the list a branch has', () =>
    Effect.gen(function* () {
      const { checkout, command } = yield* engineWith([
        { name: 'on-base', check: 'touch on-base', manual: 'never asked' },
      ])
      const git = gitIn(checkout)
      git('checkout', '--quiet', '-b', 'feature')
      writeFileSync(
        NodePath.join(checkout, '.fabrica/settings.json'),
        JSON.stringify({
          ...scriptedSettings,
          requires: [
            { name: 'on-branch', check: 'touch on-branch', manual: 'do it' },
          ],
        }),
      )
      git('add', '--all')
      git('commit', '--quiet', '--message', 'a branch’s entry')
      git('checkout', '--quiet', 'main')
      const { exit, out } = yield* command('requires')
      expect(exit).toStrictEqual(Exit.void)
      expect(out).toEqual(['on-base: met'])
      expect(existsSync(NodePath.join(checkout, 'on-branch'))).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live('--markdown prints the list for the README, and runs nothing', () =>
    Effect.gen(function* () {
      const { checkout, command } = yield* engineWith([
        { name: 'tool', check: 'touch checked', install: 'touch installed' },
      ])
      const { exit, out } = yield* command('requires', '--markdown')
      expect(exit).toStrictEqual(Exit.void)
      const printed = out.join('\n').split('\n')
      expect(printed[0]).toBe(Requirements.requirementsSectionStart)
      expect(printed.at(-1)).toBe(Requirements.requirementsSectionEnd)
      expect(printed).toContain('- **tool**')
      expect(printed).toContain('  - install: `touch installed`')
      expect(existsSync(NodePath.join(checkout, 'checked'))).toBe(false)
      expect(existsSync(NodePath.join(checkout, 'installed'))).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live('a run’s start refused for them prints the list and exits 2', () =>
    Effect.gen(function* () {
      const { command } = yield* engineWith([
        { name: 'docker', check: 'false', manual: 'start Docker Desktop' },
      ])
      const { exit, err } = yield* command('run')
      expect(exitCodeOf(exit)).toBe(2)
      expect(err).toEqual([
        '  docker (start Docker Desktop)',
        "fabrica: the run didn't start (REQUIREMENTS_MISSING)",
      ])
    }).pipe(Effect.scoped),
  )
})
