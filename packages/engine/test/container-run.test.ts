import { Effect, Option } from 'effect'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from '@effect/vitest'

import type { ContainerHost } from '../src/agent'
import { runProject } from '../src/run'
import {
  dockerRootless,
  installStub,
  stubDistribution,
  writeStubScript,
} from './container-stub'
import {
  binFolder,
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  piStub,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// A whole run of a project with a `container` (spec §12.7): a stub docker on the run's PATH, the real
// model proxy, control server and git, and the run harness's stub Pi started by the stub's `exec`. The image
// is pulled before the first dispatch, the worker's container mounts what it needs, and it is gone by the
// run's end. A rootless Linux host, so the worker reaches the proxy and the channel by mounted sockets.

let distribution: ReturnType<typeof stubDistribution>
let cli: ReturnType<typeof installStub>

beforeAll(() => {
  setUpRuns()
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ctr-run-')))
  const script = join(base, 'stub-cli')
  writeStubScript(script)
  distribution = stubDistribution({
    base,
    node: process.execPath,
    cli: piStub(),
  })
  // On the run's PATH: its state beside the harness's bin folder.
  cli = installStub({
    script,
    base: dirname(binFolder()),
    clis: ['docker'],
    distribution: distribution.root,
  })
  cli.answerInfo('docker', dockerRootless)
})

beforeEach(() => cli.reset())

const hostOf = (overrides: Partial<ContainerHost> = {}): ContainerHost => ({
  platform: 'linux',
  uid: 1000,
  gid: 1000,
  memory: 1024 ** 3,
  environment: {},
  distribution: Effect.succeed(distribution),
  readFile: () => Effect.succeed(Option.some('cpu memory pids')),
  ...overrides,
})

const withContainer = {
  ...settings,
  concurrent: 1,
  container: { image: 'node:26', cpus: 2, memory: '1g', network: 'fab-net' },
}

describe('a run with a container', () => {
  it.effect(
    'pulls before its first dispatch, runs its worker in a container and removes it',
    () =>
      Effect.gen(function* () {
        const fixture = project(withContainer)
        const end = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* file('Add one', 'finish')
            return yield* runProject({
              ...configOf(fixture, options()),
              containers: hostOf(),
            })
          }),
        )
        expect(end.code).toBe(0)
        const calls = cli.calls()
        const kinds = calls.map(([, subcommand]) => subcommand)
        expect(kinds.slice(0, 2)).toEqual(['info', 'pull'])
        expect(kinds.indexOf('pull')).toBeLessThan(kinds.indexOf('run'))
        expect(kinds.indexOf('run')).toBeLessThan(kinds.indexOf('exec'))
        expect(kinds.at(-1)).toBe('rm')
        const run = calls.find(([, subcommand]) => subcommand === 'run') ?? []
        const after = (flag: string) =>
          run.flatMap((word, at) => (word === flag ? [run[at + 1]] : []))
        expect(after('--memory')).toEqual([String(1024 ** 3)])
        expect(after('--cpus')).toEqual(['2'])
        expect(after('--network')).toEqual(['fab-net'])
        expect(after('--entrypoint')).toEqual(['/opt/fabrica/node'])
        const volumes = after('--volume')
        const gitFolder = join(fixture.checkout, '.git')
        expect(volumes).toContain(`${gitFolder}:${gitFolder}`)
        expect(volumes).toContain(
          `${join(gitFolder, 'hooks')}:${join(gitFolder, 'hooks')}:ro`,
        )
        expect(volumes).toContain(
          `${join(gitFolder, 'config')}:${join(gitFolder, 'config')}:ro`,
        )
        const logs = join(fixture.checkout, '.fabrica/run/checks')
        expect(volumes).toContain(`${logs}:${logs}:ro`)
        // Rootless Linux: both sockets mounted, and the relay given the proxy's port and socket.
        const sockets = volumes.filter(volume =>
          volume?.startsWith(fixture.sockets),
        )
        expect(sockets).toHaveLength(2)
        expect(run.at(-1)).toMatch(/\.p\.sock$/u)
        expect(Number(run.at(-2))).toBeGreaterThan(0)
        const events = yield* eventsOf(fixture)
        expect(ofKind(events, 'info').map(({ text }) => text)).toContain(
          'start: the container check: docker, node:26',
        )
      }),
  )

  it.effect('a pull that fails ends the run SETUP, with no dispatch', () =>
    Effect.gen(function* () {
      const fixture = project(withContainer)
      cli.refuse('pull')
      const end = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* file('Add one', 'finish')
          return yield* runProject({
            ...configOf(fixture, options()),
            containers: hostOf(),
          })
        }),
      )
      expect(end.code).toBe(2)
      expect(cli.calls().some(([, subcommand]) => subcommand === 'run')).toBe(
        false,
      )
      const events = yield* eventsOf(fixture)
      expect(ofKind(events, 'dispatch')).toHaveLength(0)
    }),
  )

  it.effect(
    'a host with no cpu delegation ends the run SETUP, naming the fix',
    () =>
      Effect.gen(function* () {
        const fixture = project(withContainer)
        const end = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* file('Add one', 'finish')
            return yield* runProject({
              ...configOf(fixture, options()),
              containers: hostOf({
                readFile: () => Effect.succeed(Option.some('memory pids')),
              }),
            })
          }),
        )
        expect(end.code).toBe(2)
        expect(
          cli.calls().some(([, subcommand]) => subcommand === 'pull'),
        ).toBe(false)
        const text = readFileSync(
          join(fixture.checkout, '.fabrica/run/events.jsonl'),
          'utf8',
        )
        expect(text).toContain('delegate.conf')
      }),
  )

  it.effect(
    'a setup command that fails is a setup failure, its ticket waiting, not a tool defect',
    () =>
      Effect.gen(function* () {
        const devcontainer = JSON.stringify({
          image: 'node:26',
          postCreateCommand: 'exit 3',
        })
        const fixture = project(
          {
            ...settings,
            concurrent: 1,
            container: { devcontainer: '.devcontainer/devcontainer.json' },
          },
          { '.devcontainer/devcontainer.json': devcontainer },
        )
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* file('Add one', 'finish')
            return yield* runProject({
              ...configOf(fixture, options()),
              containers: hostOf({
                readFile: path =>
                  Effect.succeed(
                    Option.some(
                      path.endsWith('devcontainer.json')
                        ? devcontainer
                        : 'cpu memory pids',
                    ),
                  ),
              }),
            })
          }),
        )
        const events = yield* eventsOf(fixture)
        const warnings = ofKind(events, 'warn').map(({ text }) => text)
        expect(warnings.some(text => text.includes('SETUP_FAILED'))).toBe(true)
        expect(
          warnings.some(text =>
            text.includes('setup command /bin/sh -c exit 3 failed'),
          ),
        ).toBe(true)
        expect(JSON.stringify(events)).not.toContain('TOOL_DEFECT')
      }),
  )

  it.effect(
    'an engine with no container facts refuses a project with a container',
    () =>
      Effect.gen(function* () {
        const fixture = project(withContainer)
        const end = yield* withRuns(
          fixture,
          runProject(configOf(fixture, options())),
        )
        expect(end.code).toBe(2)
      }),
  )
})
