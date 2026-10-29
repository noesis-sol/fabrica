import { Duration, Effect, Layer, Option, type Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeSocket from '@effect/platform-node-shared/NodeSocket'
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  CheckOwnPass,
  CommandSetting,
  CommitHash,
  ControlRpcs,
  ControlTokenVariable,
  PermissionDecision,
  ProjectId,
  SessionId,
  TicketResult,
  TreeHash,
  controlTokenClient,
} from '@fabrica/contracts'

import { layer as checksLayer } from '../src/checks'
import {
  Attention,
  CheckOwnPasses,
  ControlServer,
  type Outcome,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../src/control'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { layerWake, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// The `check_own` tool over a real control socket (spec §12.3, §13.6, H89): the engine runs the
// project's `check_own` in the worktree through the Checks service, against stub scripts and real git
// in temp folders, records a pass with the tree it ran on, and passes the last pass's tree to the
// next run; `finish` then stands on that pass once what was checked is committed.

let root = ''
let home = ''
let bin = ''
let gitFolder = ''
let counter = 0

const fixtureEnv = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for a test's fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** A folder of its own under the test's root. */
const folder = (name: string): string => {
  counter += 1
  const path = join(root, `${name}-${counter}`)
  mkdirSync(path)
  return path
}

const STUBS: Readonly<Record<string, string>> = {
  'check-pass':
    'echo "passed-at=${FABRICA_CHECK_OWN_PASSED_AT-unset} cores=$FABRICA_CORES"\n',
  'check-fail': 'echo failing\nexit 3\n',
}

beforeAll(() => {
  // Short, so the sockets' paths stay under the 103 bytes every platform takes.
  root = mkdtempSync(join(tmpdir(), 'fab-own-'))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: { PATH: `${bin}:${gitFolder}:/usr/bin:/bin`, HOME: home },
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
  readRetries: { times: 1, spacing: Duration.zero },
}

/** The services, made once the stubs' folder is known. */
const services = () => {
  const runner = Layer.provide(runnerLayer(runnerConfig()), layerClock)
  const gitService = Layer.provide(gitLayer(gitConfig), runner)
  return controlLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
          Layer.provideMerge(storeLayer(':memory:')),
        ),
        gitService,
        Layer.provide(checksLayer, Layer.merge(runner, gitService)),
        Layer.provide(layerWake, noSleepCauses),
        checkOwnPassesLayer,
        Layer.succeed(Attention)({
          permission: () =>
            Effect.succeed(PermissionDecision.cases.allow_run.make({})),
        }),
      ),
    ),
  )
}

const maintainer: Actor = { _tag: 'maintainer' }

/** A ticket's worktree, with one commit, and its control channel open with `command` as its `check_own`. */
const harness = (command: CommandSetting) =>
  Effect.gen(function* () {
    const worktree = folder('repo')
    git(worktree, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(worktree, 'README.md'), 'one\n')
    git(worktree, 'add', '--all')
    git(worktree, 'commit', '--quiet', '--message', 'one')
    const checkout = folder('checkout')
    const graph = yield* WorkGraph
    const own = yield* graph.create({
      ticket: { type: 'task', title: 'Check its own change' },
      actor: maintainer,
    })
    const control = yield* (yield* ControlServer).open({
      project: ProjectId.make('project-1'),
      ticket: own.id,
      session: SessionId.make('session-1'),
      worktree,
      folder: folder('sockets'),
      questionWait: Duration.minutes(15),
      checkOwn: {
        command,
        checkout,
        timeLimit: Duration.minutes(1),
        cores: 2,
        nice: Option.none(),
      },
    })
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(NodeSocket.layerNet({ path: control.socket })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        controlTokenClient(control.environment[ControlTokenVariable] ?? ''),
      ),
    )
    const client = yield* Effect.provide(RpcClient.make(ControlRpcs), context)
    /** The outcomes the session published, `n` of them. */
    const outcomes = (n: number) =>
      Effect.map(
        Stream.runCollect(Stream.take(control.outcomes, n)),
        (taken): ReadonlyArray<Outcome> => taken,
      )
    return { worktree, checkout, own: own.id, client, outcomes }
  })

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Scope.Scope | WorkGraph | ControlServer | CheckOwnPasses
  >,
) => Effect.scoped(body).pipe(Effect.provide(services()))

const command = (line: string) =>
  CommandSetting.cases.Command.make({ command: line })

const summary = TicketResult.cases.summary.make({ summary: 'Checked it.' })

const headOf = (worktree: string) => ({
  commit: CommitHash.make(git(worktree, 'rev-parse', 'HEAD')),
  tree: TreeHash.make(git(worktree, 'rev-parse', 'HEAD^{tree}')),
})

describe('check_own', () => {
  it.live(
    'records a pass with the tree it ran on, which finish stands on once it is committed',
    () =>
      run(
        Effect.gen(function* () {
          const { client, worktree, checkout, own, outcomes } = yield* harness(
            command('check-pass'),
          )
          writeFileSync(join(worktree, 'README.md'), 'one, changed\n')
          writeFileSync(join(worktree, 'feature.txt'), 'new\n')

          const ran = yield* client.check_own({})
          if (ran._tag !== 'passed') throw new Error(`ran: ${ran._tag}`)
          expect(ran.committed).toBe(false)
          expect(ran.output).toBe(
            join(checkout, `.fabrica/run/checks/${own}.own.log`),
          )
          expect(readFileSync(ran.output, 'utf8')).toBe(
            'passed-at=unset cores=2\n',
          )
          const [checked] = yield* outcomes(1)
          expect(checked?._tag).toBe('Checked')
          if (checked?._tag === 'Checked') {
            expect(checked.check.suite).toBe('own')
            expect(checked.check.result).toBe('passed')
          }
          expect(
            yield* (yield* CheckOwnPasses).passed({
              ticket: own,
              tree: ran.tree,
            }),
          ).toBe(true)

          git(worktree, 'add', '--all')
          git(worktree, 'commit', '--quiet', '--message', 'the change')
          const { commit, tree } = headOf(worktree)
          expect(tree).toBe(ran.tree)
          const checkOwn = new CheckOwnPass({
            commit,
            tree,
            output: ran.output,
          })
          expect(yield* client.finish({ checkOwn, result: summary })).toEqual(
            {},
          )
        }),
      ),
  )

  it.live(
    'says the tree is HEAD’s when nothing is uncommitted, and passes the last pass’s tree to the next run',
    () =>
      run(
        Effect.gen(function* () {
          const { client, worktree } = yield* harness(command('check-pass'))
          const first = yield* client.check_own({})
          if (first._tag !== 'passed') throw new Error(`ran: ${first._tag}`)
          expect(first.committed).toBe(true)
          expect(first.tree).toBe(headOf(worktree).tree)

          writeFileSync(join(worktree, 'README.md'), 'two\n')
          const second = yield* client.check_own({})
          if (second._tag !== 'passed') throw new Error(`ran: ${second._tag}`)
          expect(second.tree).not.toBe(first.tree)
          expect(readFileSync(second.output, 'utf8')).toBe(
            `passed-at=${first.tree} cores=2\n`,
          )
        }),
      ),
  )

  it.live('records nothing for a check that fails', () =>
    run(
      Effect.gen(function* () {
        const { client, worktree, own } = yield* harness(command('check-fail'))
        const ran = yield* client.check_own({})
        if (ran._tag !== 'failed') throw new Error(`ran: ${ran._tag}`)
        expect(ran.exit).toBe('exit 3')
        expect(readFileSync(ran.output, 'utf8')).toBe('failing\n')
        const passes = yield* CheckOwnPasses
        expect(yield* passes.passed({ ticket: own, tree: ran.tree })).toBe(
          false,
        )
        expect(yield* passes.last(own)).toEqual(Option.none())
        const { commit, tree } = headOf(worktree)
        const refused = yield* Effect.flip(
          client.finish({
            checkOwn: new CheckOwnPass({ commit, tree, output: ran.output }),
            result: summary,
          }),
        )
        expect(refused).toEqual({ _tag: 'check_own_not_passed', tree })
      }),
    ),
  )

  it.live('runs nothing where the project sets no check_own', () =>
    run(
      Effect.gen(function* () {
        const unset = yield* harness(CommandSetting.cases.Unset.make({}))
        expect(yield* unset.client.check_own({})).toEqual({
          _tag: 'not_run',
          reason: "the project's check_own isn't set",
        })
        const none = yield* harness(CommandSetting.cases.None.make({}))
        expect(yield* none.client.check_own({})).toEqual({
          _tag: 'not_run',
          reason: 'the project\'s check_own is "none"',
        })
      }),
    ),
  )

  it.live('fails a command its shell cannot find, recording nothing', () =>
    run(
      Effect.gen(function* () {
        const { client, own } = yield* harness(command('no-such-check'))
        const ran = yield* client.check_own({})
        expect(ran).toMatchObject({ _tag: 'failed', exit: 'exit 127' })
        expect(yield* (yield* CheckOwnPasses).last(own)).toEqual(Option.none())
      }),
    ),
  )
})
