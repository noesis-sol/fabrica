import { Duration, Effect, Layer, Option } from 'effect'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ContainerSource, ProjectId } from '@fabrica/contracts'

import {
  RuntimeChoice,
  RuntimePlacement,
  chooseRuntime,
  dockerDesktopProblem,
  prepareContainers,
} from '../src/agent'
import {
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  dockerRootful,
  installStub,
  podmanRootless,
  stubDistribution,
  writeStubScript,
} from './container-stub'

// Docker Desktop connects a mounted Unix socket only since 4.40 (spec §12.7, fab-mgi.2.8): an older one
// is refused at the start, with what to update, rather than starting workers whose extension's first
// control call fails. Against a stub docker and podman at the process boundary.

let root = ''
let script = ''
let counter = 0

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ctr-dd-')))
  script = join(root, 'stub-cli')
  writeStubScript(script)
})

const fixture = (clis: ReadonlyArray<string> = ['docker', 'podman']) => {
  counter += 1
  const base = join(root, `t${counter}`)
  const worktree = join(base, 'worktree')
  mkdirSync(worktree, { recursive: true })
  const distribution = stubDistribution({
    base,
    node: process.execPath,
    cli: join(root, 'unused.mjs'),
  })
  const cli = installStub({
    script,
    base,
    clis,
    distribution: distribution.root,
  })
  const runner = runnerLayer({
    hostEnvironment: {
      PATH: `${cli.bin}:/usr/bin:/bin`,
      HOME: base,
      LANG: 'C',
    },
    enginePriority: 0,
    priority: hostPriority,
    listProcesses,
    pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
    self: process.pid,
    killGrace: Duration.millis(500),
    outputGrace: Duration.millis(200),
  }).pipe(Layer.provide(layerClock))
  return { worktree, distribution, cli, runner }
}

const versionOf = (name: string) => ({
  Client: { Version: '28.0.1' },
  Server: { Platform: { Name: name } },
})

const choose = (
  state: ReturnType<typeof fixture>,
  wanted: Option.Option<'docker' | 'podman'>,
  platform = 'darwin',
) =>
  chooseRuntime({ wanted, platform, cwd: state.worktree }).pipe(
    Effect.provide(state.runner),
  )

const problemOf = (name: string) =>
  dockerDesktopProblem({ version: JSON.stringify(versionOf(name)) })

describe('reading a Docker Desktop release', () => {
  it('refuses a release before 4.40, its release named and the one to update to', () => {
    expect(Option.getOrThrow(problemOf('Docker Desktop 4.39.0 (184744)'))).toBe(
      "Docker Desktop 4.39.0 can't connect a Unix socket mounted in a container, which a worker's extension needs: update it to 4.40 or later",
    )
  })

  it('compares the numbers, not the text', () => {
    expect(Option.isSome(problemOf('Docker Desktop 4.9.0 (1)'))).toBe(true)
    expect(Option.isSome(problemOf('Docker Desktop 3.99.1 (1)'))).toBe(true)
    expect(problemOf('Docker Desktop 4.40.0 (187762)')).toEqual(Option.none())
    expect(problemOf('Docker Desktop 4.100.0 (1)')).toEqual(Option.none())
    expect(problemOf('Docker Desktop 5.0.0 (1)')).toEqual(Option.none())
  })

  it('has nothing against another engine, or a name that says no release', () => {
    expect(problemOf('Docker Engine - Community')).toEqual(Option.none())
    expect(problemOf('')).toEqual(Option.none())
    expect(problemOf('Docker Desktop')).toEqual(Option.none())
  })

  it('has nothing against an answer it can read nothing from', () => {
    expect(dockerDesktopProblem({ version: 'not json' })).toEqual(Option.none())
    expect(
      dockerDesktopProblem({ version: JSON.stringify({ Server: null }) }),
    ).toEqual(Option.none())
    expect(
      dockerDesktopProblem({ version: JSON.stringify({ Server: {} }) }),
    ).toEqual(Option.none())
  })
})

describe('choosing Docker on a Mac', () => {
  it.live('takes Docker Desktop 4.40', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerVersion(
        'docker',
        versionOf('Docker Desktop 4.40.0 (187762)'),
      )
      expect(yield* choose(state, Option.none())).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.DockerDesktop(),
          notices: [],
        }),
      )
    }),
  )

  it.live('refuses an older one, with what to update', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerVersion(
        'docker',
        versionOf('Docker Desktop 4.39.0 (184744)'),
      )
      const chosen = yield* choose(state, Option.some('docker'))
      if (!RuntimeChoice.$is('Refused')(chosen))
        return expect.unreachable('it chose one')
      expect(chosen.problem).toContain(
        "docker: Docker Desktop 4.39.0 can't connect a Unix socket",
      )
      expect(chosen.problem).toContain('update it to 4.40 or later')
    }),
  )

  it.live('takes Podman Machine where the older one is all Docker has', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerVersion(
        'docker',
        versionOf('Docker Desktop 4.39.0 (184744)'),
      )
      state.cli.answerInfo('podman', podmanRootless)
      expect(yield* choose(state, Option.none())).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.PodmanMachine({ rootless: true }),
          notices: [],
        }),
      )
    }),
  )

  it.live("takes one whose version it can't read", () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.refuse('version')
      expect(yield* choose(state, Option.none())).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.DockerDesktop(),
          notices: [],
        }),
      )
    }),
  )

  it.live('asks Docker alone, and only on a Mac', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerVersion(
        'docker',
        versionOf('Docker Desktop 4.39.0 (184744)'),
      )
      state.cli.answerInfo('podman', podmanRootless)
      yield* choose(state, Option.some('podman'))
      expect(
        state.cli.calls().some(([, subcommand]) => subcommand === 'version'),
      ).toBe(false)
      state.cli.reset()
      const onLinux = yield* choose(state, Option.some('docker'), 'linux')
      expect(onLinux).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.RootfulLinux({ runtime: 'docker' }),
          notices: [
            'only a rootful docker daemon was found; a rootless runtime is preferred (§12.7)',
          ],
        }),
      )
      expect(
        state.cli.calls().some(([, subcommand]) => subcommand === 'version'),
      ).toBe(false)
    }),
  )
})

describe("a run's start with an older Docker Desktop", () => {
  it.live('stops before any image is pulled, on a problem line', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerVersion(
        'docker',
        versionOf('Docker Desktop 4.39.0 (184744)'),
      )
      const failure = yield* prepareContainers({
        container: {
          source: ContainerSource.cases.Image.make({ image: 'node:26' }),
          runtime: Option.none(),
          memory: Option.none(),
          cpus: Option.none(),
          network: Option.none(),
        },
        host: {
          platform: 'darwin',
          uid: 501,
          gid: 20,
          memory: 2 * 1024 ** 3,
          environment: {},
          distribution: Effect.succeed(state.distribution),
          readFile: () => Effect.succeed(Option.none()),
        },
        project: ProjectId.make('p1'),
        checkout: state.worktree,
        cores: 2,
      }).pipe(Effect.provide(state.runner), Effect.flip)
      expect(failure.problems).toHaveLength(1)
      expect(failure.problems[0]).toContain('update it to 4.40 or later')
      expect(
        state.cli.calls().some(([, subcommand]) => subcommand === 'pull'),
      ).toBe(false)
    }),
  )
})
