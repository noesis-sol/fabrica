import { DateTime, Duration, Effect, Layer, Option, Redacted } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PermissionDecision } from '@fabrica/contracts'

import { layer as agentLayer } from '../src/agent'
import { layer as checksLayer } from '../src/checks'
import { Attention } from '../src/control'
import {
  type Git,
  type GitConfig,
  layer as gitLayer,
  worktreesLayer,
} from '../src/git'
import { MergeWaits } from '../src/merge'
import {
  Deadlines,
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  Authentication,
  ModelProxy,
  type ProviderRoute,
  layerOpen,
  make as makeProxy,
} from '../src/proxy'
import { RunHosting, RunHostingShape } from '../src/run/hosting'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import { layerWake, noSleepCauses } from '../src/time'
import { anthropicAnswer } from './proxy-streams'

// A test engine's runs on a scripted agent (spec §13, §24): the run hosting a daemon is started with,
// over the live agents, checks, git, worktrees and model proxy, whose only stand-ins are at the
// boundary: Pi's CLI is a stub speaking its RPC protocol, which does what its ticket's description
// says (`stub: finish`, `stub: hang`, `stub: wait <file>`) through the real control socket, and the
// model provider is a loopback server that takes every key. Shared by the Runs group's tests and the
// CLI's `fabrica run` and `fabrica follow` tests.

/**
 * A stub of `pi --mode rpc`. On its prompt it reads its ticket with `get_ticket` over the control
 * socket and does what the ticket's `stub:` line says: `finish` (commits a file, runs `check_own`,
 * finishes with its pass), `wait <file>` (finishes once the file is there), or `hang` (works until it
 * is stopped).
 */
const STUB = `import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const sessionId = 's-' + process.pid
const sessionFile = sessions + '/' + sessionId + '.jsonl'
process.on('SIGTERM', () => process.exit(0))
let socket
let pending = ''
let next = 0
const waiting = new Map()
const control = () => {
  if (socket !== undefined) return socket
  socket = connect(process.env.FABRICA_CONTROL_SOCKET)
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    pending += chunk
    for (let at = pending.indexOf('\\n'); at !== -1; at = pending.indexOf('\\n')) {
      const message = JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
      if (message._tag !== 'Exit') continue
      const resolve = waiting.get(String(message.requestId))
      waiting.delete(String(message.requestId))
      resolve?.(message.exit)
    }
  })
  return socket
}
const call = (tag, payload) =>
  new Promise(resolve => {
    const id = String(next++)
    waiting.set(id, resolve)
    control().write(JSON.stringify({
      _tag: 'Request', id, tag, payload,
      headers: [['x-fabrica-control-token', process.env.FABRICA_CONTROL_TOKEN]],
    }) + '\\n')
  }).then(exit => {
    if (exit._tag !== 'Success') throw new Error(tag + ' failed: ' + JSON.stringify(exit))
    return exit.value
  })
const git = (...words) => execFileSync('git', words, { encoding: 'utf8' }).trim()
const work = async () => {
  const view = await call('get_ticket', {})
  const ticket = view.ticket
  const [action, target] = ((ticket.description ?? '').match(/stub: (.*)/)?.[1] ?? 'finish').split(' ')
  if (action === 'hang') return new Promise(() => {})
  if (action === 'wait')
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!existsSync(target)) return
        clearInterval(timer)
        resolve()
      }, 20)
    })
  writeFileSync(ticket.id + '.txt', ticket.title + '\\n')
  git('add', '--all')
  git('commit', '--quiet', '--message', ticket.title)
  const checked = await call('check_own', {})
  return call('finish', {
    checkOwn: { tree: checked.tree, commit: git('rev-parse', 'HEAD'), output: checked.output },
    result: { _tag: 'summary', summary: 'Built ' + ticket.title },
  })
}
const handle = command => {
  switch (command.type) {
    case 'get_state':
      return respond(command.id, 'get_state', { sessionId, sessionFile, isStreaming: false, messageCount: 0 })
    case 'prompt':
      respond(command.id, 'prompt', { disposition: 'started' })
      out({ type: 'agent_start' })
      return work()
        .catch(() => {})
        .finally(() => {
          out({ type: 'agent_end', messages: [], willRetry: false })
          out({ type: 'agent_settled', aborted: false })
        })
    default:
      return respond(command.id, command.type)
  }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at !== -1; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** A project's settings for a scripted run: one model, and a check that passes as its merge check. */
export const scriptedSettings = {
  concurrent: 1,
  model: 'anthropic/claude-test',
  check_own: 'check-pass',
  check_fast: 'check-pass',
  // The stub plays a worker only: the verifier's rounds are verifier.test.ts's.
  verifier: { enabled: false },
}

/** The folders and files a scripted run's engine works with. */
export interface ScriptedPlaces {
  /** Short, so the control sockets' paths stay under the 103 bytes every platform takes. */
  readonly root: string
  readonly home: string
  /** Holds `check-pass`. */
  readonly bin: string
  readonly gitFolder: string
  readonly stub: string
  readonly extension: string
}

/** Makes a scripted run's folders: a home with git's identity, the check, the stub and the extension. */
export const makeScriptedPlaces = (): ScriptedPlaces => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-rr-')))
  const home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  const gitFolder = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
  }).trim()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'check-pass'), '#!/bin/sh\necho passing\n')
  chmodSync(join(bin, 'check-pass'), 0o755)
  const stub = join(root, 'pi-stub.mjs')
  writeFileSync(stub, STUB)
  const extension = join(root, 'extension.js')
  writeFileSync(extension, 'export default function () {}\n')
  return { root, home, bin, gitFolder, stub, extension }
}

/** The environment git runs with, in a fixture and in the engine. */
export const fixtureEnvironment = (places: ScriptedPlaces) => ({
  PATH: `${places.bin}:${places.gitFolder}:/usr/bin:/bin`,
  HOME: places.home,
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** A project's checkout on `main` with its settings committed, in a folder of its own. */
export const makeCheckout = (
  places: ScriptedPlaces,
  settings: object = scriptedSettings,
): string => {
  const checkout = mkdtempSync(join(places.root, 'c'))
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync('git', args, {
      cwd: checkout,
      env: fixtureEnvironment(places),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '--quiet', '--initial-branch=main')
  const files: Record<string, string> = {
    'README.md': 'one\n',
    '.gitignore': '.fabrica/run/\n.fabrica/fabrica.log\n',
    '.fabrica/settings.json': `${JSON.stringify(settings, null, 2)}\n`,
  }
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, name)), { recursive: true })
    writeFileSync(join(checkout, name), content)
  }
  git('add', '--all')
  git('commit', '--quiet', '--message', 'one')
  return checkout
}

/** The runner's configuration: the fixture's environment, the host's process table. */
export const runnerConfig = (places: ScriptedPlaces): RunnerConfig => ({
  hostEnvironment: fixtureEnvironment(places),
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

/** The engine's own git, with the fixture's environment. */
export const engineGit = (places: ScriptedPlaces): Layer.Layer<Git> =>
  gitLayer(gitConfig).pipe(
    Layer.provide(runnerLayer(runnerConfig(places))),
    Layer.provide(layerClock),
  )

/** The process boundary's deadlines on the live clock: the stub and git exit in real time. */
const liveDeadlines = Layer.succeed(Deadlines, {
  sleep: duration => Effect.sleep(duration),
})

/** A loopback Anthropic that takes every key, closed with the scope. */
export const takingProvider = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>(
    resume => {
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          response.writeHead(200, {
            'content-type': anthropicAnswer.contentType,
          })
          response.end(anthropicAnswer.body)
        })
      })
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            close: () => {
              server.close()
              server.closeAllConnections()
            },
          }),
        )
      })
    },
  ),
  provider => Effect.sync(provider.close),
)

/** The secret store: the loopback Anthropic's key, and no other. */
export const testSecrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: name =>
    name === 'anthropic'
      ? Effect.succeed(Redacted.make('sk-ant-test-key'))
      : Effect.fail(new SecretMissing({ name })),
  remove: () => Effect.succeed(false),
})

/** The loopback provider's route, at `url`. */
export const routesAt = (url: string): ReadonlyArray<ProviderRoute> => [
  {
    provider: 'anthropic',
    upstream: `${url}/anthropic`,
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make('anthropic'),
    }),
  },
]

/** Every permission a worker asks for is allowed. */
const allowing = Layer.succeed(Attention)(
  Attention.of({
    permission: () =>
      Effect.succeed(PermissionDecision.cases.allow_run.make({})),
  }),
)

/** The run hosting of a test engine whose agents are the scripted Pi, its data in `data`. */
export const scriptedHosting = (
  places: ScriptedPlaces,
  data: string,
): Layer.Layer<RunHosting> =>
  Layer.effect(
    RunHosting,
    Effect.gen(function* () {
      const provider = yield* takingProvider
      const runner = Layer.provideMerge(
        runnerLayer(runnerConfig(places)),
        liveDeadlines,
      )
      const gitServices = Layer.provideMerge(
        worktreesLayer,
        Layer.provideMerge(gitLayer(gitConfig), runner),
      )
      const proxy = Layer.effect(
        ModelProxy,
        makeProxy({ routes: routesAt(provider.url) }),
      ).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(Secrets)(testSecrets), layerOpen),
        ),
      )
      const services = yield* Layer.build(
        Layer.mergeAll(
          checksLayer,
          Layer.provide(layerWake, noSleepCauses),
          allowing,
          Layer.succeed(MergeWaits, {
            beforeRetry: Effect.sleep('3 seconds'),
            poll: Effect.sleep('2 seconds'),
          }),
          agentLayer({
            node: process.execPath,
            cli: places.stub,
            extension: places.extension,
            data: join(data, 'agents-data'),
            configRoot: join(data, 'agents'),
            limits: {
              handshake: Duration.seconds(10),
              answer: Duration.seconds(10),
              abort: Duration.seconds(5),
              reap: Duration.seconds(5),
            },
            reaperPoll: Duration.millis(200),
            reaperGrace: Duration.millis(500),
          }),
          proxy,
          DateTime.layerCurrentZoneOffset(0),
        ).pipe(Layer.provideMerge(gitServices)),
      ).pipe(Effect.orDie)
      const sockets = mkdtempSync(join(places.root, 's'))
      return RunHostingShape.Ready({
        services,
        sockets,
        cores: 1,
        nice: Option.none(),
        environment: {},
      })
    }),
  )
