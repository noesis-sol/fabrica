import { Duration, Effect, Layer, Option, type Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  Outcome,
  OwnCheck,
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

// `finish` as the project's `check_own` asks, over a real control socket (spec §12.3, H62, H89): where
// it is "none", nothing records a pass, so `finish` takes "none" in its place and the outcome says the
// work finished unchecked; where it is set, or not set at all, "none" is refused.

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
  'check-pass': 'echo passed\n',
}

beforeAll(() => {
  // Short, so the sockets' paths stay under the 103 bytes every platform takes.
  root = mkdtempSync(join(tmpdir(), 'fab-none-'))
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

const none = CommandSetting.cases.None.make({})

describe('finish where check_own is "none"', () => {
  it.live(
    'takes "none", records the result, and says the work finished unchecked',
    () =>
      run(
        Effect.gen(function* () {
          const { client, worktree, own, outcomes } = yield* harness(none)
          expect(yield* client.check_own({})).toEqual({
            _tag: 'not_run',
            reason:
              'the project\'s check_own is "none": finish with checkOwn "none", unchecked',
          })
          writeFileSync(join(worktree, 'feature.txt'), 'new\n')
          git(worktree, 'add', '--all')
          git(worktree, 'commit', '--quiet', '--message', 'the change')

          expect(
            yield* client.finish({ checkOwn: 'none', result: summary }),
          ).toEqual({})
          const { ticket } = yield* (yield* WorkGraph).show(own)
          expect(ticket.result).toEqual(Option.some(summary))
          expect(yield* outcomes(1)).toEqual([
            Outcome.Finished({
              result: summary,
              checkOwn: OwnCheck.Unchecked(),
            }),
          ])
        }),
      ),
  )

  it.live('still refuses a worktree with changes left', () =>
    run(
      Effect.gen(function* () {
        const { client, worktree } = yield* harness(none)
        writeFileSync(join(worktree, 'feature.txt'), 'new\n')
        const refused = yield* Effect.flip(
          client.finish({ checkOwn: 'none', result: summary }),
        )
        expect(refused).toEqual({
          _tag: 'worktree_dirty',
          uncommitted: [],
          untracked: ['feature.txt'],
        })
      }),
    ),
  )

  it.live('refuses a pass, which nothing could have recorded', () =>
    run(
      Effect.gen(function* () {
        const { client, worktree } = yield* harness(none)
        const refused = yield* Effect.flip(
          client.finish({
            checkOwn: new CheckOwnPass({ ...headOf(worktree), output: 'log' }),
            result: summary,
          }),
        )
        expect(refused._tag).toBe('invalid')
      }),
    ),
  )
})

describe('finish with "none" where check_own is not "none"', () => {
  it.live('is refused where check_own is a command, or not set', () =>
    run(
      Effect.gen(function* () {
        for (const setting of [
          command('check-pass'),
          CommandSetting.cases.Unset.make({}),
        ]) {
          const { client, own } = yield* harness(setting)
          const refused = yield* Effect.flip(
            client.finish({ checkOwn: 'none', result: summary }),
          )
          expect(refused._tag).toBe('invalid')
          const { ticket } = yield* (yield* WorkGraph).show(own)
          expect(ticket.result).toEqual(Option.none())
        }
      }),
    ),
  )
})
