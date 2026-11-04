import { Duration, Effect, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, TicketId } from '@fabrica/contracts'

import {
  PiAgent,
  type PreparedContainers,
  RuntimePlacement,
  layer as agentLayer,
} from '../src/agent'
import {
  containedNice,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  niceArguments,
  layer as runnerLayer,
} from '../src/process'
import {
  installStub,
  stubDistribution,
  writeStubScript,
} from './container-stub'

// `worker_nice` inside a worker's container (spec §7.3, §12.7): a nice value on the runtime's CLI stays on
// the host, so the mounted Node sets the agent's process as it starts. Real Node at each step, as what is
// tested is what the operating system says of it; the stub CLI's `exec` starts the stub Pi, on a runner
// that leaves the CLI's own priority alone, so what Pi reads is what its arguments set.

const PI = `import { writeFileSync } from 'node:fs'
import { getPriority } from 'node:os'
writeFileSync(process.env.PI_STUB_NOTE, JSON.stringify({ nice: getPriority(), args: process.argv.slice(2) }))
let text = ''
process.stdin.on('data', chunk => {
  text += chunk
  for (;;) {
    const end = text.indexOf('\\n')
    if (end === -1) return
    const command = JSON.parse(text.slice(0, end))
    text = text.slice(end + 1)
    const data = command.type === 'get_state'
      ? { sessionId: 's-1', sessionFile: '/tmp/s-1.jsonl', isStreaming: false, messageCount: 0 }
      : undefined
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

const PRINT_NICE = `console.log(require('node:os').getPriority())`

/** What Node prints of its own nice value under `preloads`. */
const niceUnder = (...preloads: ReadonlyArray<ReadonlyArray<string>>) =>
  Number(
    execFileSync(process.execPath, [...preloads.flat(), '-e', PRINT_NICE], {
      encoding: 'utf8',
    }),
  )

describe('the nice value a container is asked for', () => {
  it('is worker_nice over an engine at a higher priority', () => {
    expect(containedNice({ nice: Option.some(10), engine: 0 })).toEqual(
      Option.some(10),
    )
    expect(containedNice({ nice: Option.some(10), engine: -10 })).toEqual(
      Option.some(10),
    )
  })

  it("is the engine's own where that is lower, which inheritance won't bring", () => {
    expect(containedNice({ nice: Option.some(10), engine: 15 })).toEqual(
      Option.some(15),
    )
  })

  it('is nothing where the agent has none', () => {
    expect(containedNice({ nice: Option.none(), engine: 15 })).toEqual(
      Option.none(),
    )
  })
})

describe('the arguments that set it', () => {
  it('lower the process before its script runs', () => {
    expect(niceUnder(niceArguments(19))).toBe(19)
  })

  it('never raise a process already lower', () => {
    expect(niceUnder(niceArguments(19), niceArguments(18))).toBe(19)
  })

  it('leave the script its arguments', () => {
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))'
    expect(
      JSON.parse(
        execFileSync(
          process.execPath,
          [...niceArguments(19), '-e', script, 'one', 'two'],
          { encoding: 'utf8' },
        ),
      ),
    ).toEqual(['one', 'two'])
  })

  // Linux keeps a nice value per thread, so this pins that the thread that spawns has it. Only there:
  // GitHub's macOS runners raise a lowered process back within 100 ms, which a second process's read may see.
  it.runIf(process.platform === 'linux')(
    'reach the commands the process spawns',
    () => {
      const script = `console.log(require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(PRINT_NICE)}], { encoding: 'utf8' }))`
      expect(
        Number(
          execFileSync(process.execPath, [...niceArguments(19), '-e', script], {
            encoding: 'utf8',
          }),
        ),
      ).toBe(19)
    },
  )
})

describe('an agent in a container', () => {
  let root = ''
  let script = ''
  let piCli = ''
  let counter = 0

  beforeAll(() => {
    // Short, for the socket paths; real, as a working folder reads it.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-nice-')))
    script = join(root, 'stub-cli')
    writeStubScript(script)
    piCli = join(root, 'pi.mjs')
    writeFileSync(piCli, PI)
  })

  /** What the stub Pi read of itself, and the CLI's calls, for an agent started at `nice`. */
  const started = ({
    nice,
    enginePriority,
  }: {
    readonly nice: Option.Option<number>
    readonly enginePriority: number
  }) =>
    Effect.gen(function* () {
      counter += 1
      const base = join(root, `t${counter}`)
      const worktree = join(base, 'worktree')
      mkdirSync(worktree, { recursive: true })
      const distribution = stubDistribution({
        base,
        node: process.execPath,
        cli: piCli,
      })
      const cli = installStub({
        script,
        base,
        clis: ['docker'],
        distribution: distribution.root,
      })
      const note = join(base, 'pi-note')
      const prepared: PreparedContainers = {
        placement: RuntimePlacement.RootlessLinux({ runtime: 'docker' }),
        image: 'node:26',
        setup: {
          id: 'abc',
          containerEnv: {},
          remoteEnv: {},
          containerUser: Option.none(),
          remoteUser: Option.none(),
          workspaceFolder: Option.none(),
          init: false,
          lifecycle: [],
        },
        memory: 1024,
        cpus: 2,
        network: Option.none(),
        distribution,
        uid: 1000,
        gid: 1001,
        enginePriority,
        environment: {},
        notices: [],
      }
      const runner = runnerLayer({
        hostEnvironment: {
          PATH: `${cli.bin}:/usr/bin:/bin`,
          HOME: base,
          LANG: 'C',
        },
        // Above any nice value here, so the runner never sets the CLI's.
        enginePriority: 19,
        priority: hostPriority,
        listProcesses,
        pipeHolders: hostHolders({
          platform: process.platform,
          self: process.pid,
        }),
        self: process.pid,
        killGrace: Duration.millis(500),
        outputGrace: Duration.millis(200),
      }).pipe(Layer.provide(layerClock))
      yield* Effect.gen(function* () {
        const agents = yield* PiAgent
        const agent = yield* agents
          .start({
            ticket: TicketId.make('fa-1'),
            project: ProjectId.make('p1'),
            worktree,
            providers: [],
            token: 'agent-token-1',
            model: Option.none(),
            tools: Option.none(),
            resume: Option.none(),
            env: { PI_STUB_NOTE: note },
            projectTrusted: false,
            nice,
            container: {
              prepared,
              mounts: [],
              relay: Option.none(),
              identity: { name: Option.none(), email: Option.none() },
            },
          })
          .pipe(Effect.scoped)
        yield* agent.close
      }).pipe(
        Effect.provide(
          agentLayer({
            node: process.execPath,
            cli: 'unused on the host',
            extension: 'unused on the host',
            data: join(base, 'data'),
            configRoot: join(base, 'agents'),
            limits: {
              handshake: Duration.seconds(10),
              answer: Duration.seconds(10),
              abort: Duration.seconds(1),
              reap: Duration.seconds(5),
            },
            reaperPoll: Duration.millis(200),
            reaperGrace: Duration.millis(500),
          }).pipe(Layer.provideMerge(runner), Layer.provide(layerClock)),
        ),
      )
      const exec =
        cli.calls().find(([, subcommand]) => subcommand === 'exec') ?? []
      const read: {
        readonly nice: number
        readonly args: ReadonlyArray<string>
      } = JSON.parse(readFileSync(note, 'utf8'))
      return { exec, read }
    })

  it.live('runs Pi at worker_nice, set inside by the mounted Node', () =>
    Effect.gen(function* () {
      const { exec, read } = yield* started({
        nice: Option.some(19),
        enginePriority: 0,
      })
      expect(read.nice).toBe(19)
      const node = exec.indexOf('/opt/fabrica/node')
      expect(exec.slice(node + 1, node + 4)).toEqual([
        ...niceArguments(19),
        '/opt/fabrica/cli.mjs',
      ])
      expect(read.args.slice(0, 2)).toEqual(['--mode', 'rpc'])
    }),
  )

  it.live("asks for the engine's own where the engine runs lower", () =>
    Effect.gen(function* () {
      const { exec, read } = yield* started({
        nice: Option.some(12),
        enginePriority: 19,
      })
      expect(read.nice).toBe(19)
      expect(exec).toContain(niceArguments(19)[1])
    }),
  )

  it.live('asks for nothing where the agent has no nice value', () =>
    Effect.gen(function* () {
      const { exec } = yield* started({
        nice: Option.none(),
        enginePriority: 0,
      })
      expect(exec).not.toContain('--import')
    }),
  )
})
