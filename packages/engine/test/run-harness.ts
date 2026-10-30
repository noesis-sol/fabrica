import { DateTime, Duration, Effect, Layer, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
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

import {
  type Actor,
  EngineId,
  PermissionDecision,
  ProjectId,
  type RunEvent,
  RunId,
  type TicketId,
} from '@fabrica/contracts'

import { layer as agentLayer } from '../src/agent'
import { layer as checksLayer } from '../src/checks'
import {
  Attention,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../src/control'
import {
  type GitConfig,
  besideCheckout,
  layer as gitLayer,
  worktreesLayer,
} from '../src/git'
import { MergeWaits } from '../src/merge'
import {
  Deadlines,
  type RunnerConfig,
  hostHolders,
  hostPriority,
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
import {
  type RunConfig,
  RunMode,
  type RunOptions,
  runProject,
} from '../src/run'
import { layerRunLog, readEvents } from '../src/runlog'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import { layerWake, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { anthropicAnswer, anthropicBadKey } from './proxy-streams'

// Whole runs for the run loop's scenarios (spec §13, H78), as run-core.test.ts runs them: the live
// PiAgent over a scripted Pi, real git in temp folders, the live control server, merge queue, checks
// and model proxy, on TestClock. The only stand-ins are at the boundary: Pi's CLI is a stub speaking
// its RPC protocol, which does what its ticket's description says (`stub: finish`, `stub: defer`, …)
// through the real control socket, and the model provider is a loopback server.

/**
 * A stub of `pi --mode rpc`. On its prompt it reads its ticket with `get_ticket` over the control
 * socket (Effect RPC's NDJSON protocol, the token in each request's headers) and does what the
 * ticket's `stub:` line says: `finish [<file>,…]` (commits a file of its own and appends a line to each
 * file named, runs `check_own`, finishes with its pass),
 * `defer`, `wait_for <ticket>` (then finishes once a note says it waited), `ask`, or `nothing` (settles
 * with no outcome). It keeps what it was prompted with and every call in its session folder.
 */
const STUB = `import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const note = entry => appendFileSync(join(sessions, 'stub.jsonl'), JSON.stringify(entry) + '\\n')
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const sessionId = 's-' + process.pid
const sessionFile = join(sessions, sessionId + '.jsonl')
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
    note({ event: 'call', tag, exit })
    if (exit._tag !== 'Success') throw new Error(tag + ' failed: ' + JSON.stringify(exit))
    return exit.value
  })
const git = (...words) => execFileSync('git', words, { encoding: 'utf8' }).trim()
const work = async () => {
  const view = await call('get_ticket', {})
  const ticket = view.ticket
  const [action, target] = ((ticket.description ?? '').match(/stub: (.*)/)?.[1] ?? 'finish').split(' ')
  const waited = view.notes.some(note => note.body.startsWith('Waiting on'))
  if (action === 'nothing') return
  if (action === 'defer') return call('defer', { reason: 'it needs a decision first' })
  if (action === 'wait_for' && !waited) return call('wait_for', { ticket: target, needs: 'its API' })
  if (action === 'ask')
    return call('ask_question', {
      title: 'Keep the old flag?',
      description: 'The flag is read nowhere now.',
      choices: { options: [{ label: 'Keep it', tradeOff: 'Nothing changes.' }, { label: 'Drop it', tradeOff: 'Less to read.' }], recommended: 0 },
      consequential: false,
      maintainerOnly: false,
    })
  writeFileSync(ticket.id + '.txt', ticket.title + '\\n')
  for (const name of (target ?? '').split(',').filter(name => name !== '')) appendFileSync(name, ticket.title + '\\n')
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
      note({ event: 'prompt', message: command.message })
      out({ type: 'agent_start' })
      return work()
        .catch(error => note({ event: 'error', message: String(error) }))
        .finally(() => {
          out({ type: 'agent_end', messages: [], willRetry: false })
          out({ type: 'agent_settled', aborted: false })
        })
    case 'abort':
      return respond(command.id, 'abort')
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

/** The folders and files every run of a test file shares, made by `setUpRuns`. */
const shared = {
  root: '',
  home: '',
  bin: '',
  gitFolder: '',
  stub: '',
  extension: '',
  counter: 0,
}

/** The folder of the test file's commands, on the PATH its runs run with. */
export const binFolder = () => shared.bin

const fixtureEnv = () => ({
  PATH: `${shared.gitFolder}:/usr/bin:/bin`,
  HOME: shared.home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for a test's fixture, its output trimmed. */
export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** Writes `files` in `cwd` and commits them as `message`. */
export const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', message)
}

/** Makes the folders, the stub and the check commands every run of a test file shares: in its `beforeAll`. */
export const setUpRuns = () => {
  // Short, so the control sockets' paths stay under the 103 bytes every platform takes.
  shared.root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-run-')))
  shared.home = join(shared.root, 'home')
  mkdirSync(shared.home)
  writeFileSync(
    join(shared.home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  shared.gitFolder = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
  }).trim()
  shared.bin = join(shared.root, 'bin')
  mkdirSync(shared.bin)
  writeFileSync(join(shared.bin, 'check-pass'), '#!/bin/sh\necho passing\n')
  chmodSync(join(shared.bin, 'check-pass'), 0o755)
  shared.stub = join(shared.root, 'pi-stub.mjs')
  writeFileSync(shared.stub, STUB)
  shared.extension = join(shared.root, 'extension.js')
  writeFileSync(shared.extension, 'export default function () {}\n')
}

export const settings = {
  concurrent: 2,
  model: 'anthropic/claude-test',
  check_own: 'check-pass',
  check_fast: 'check-pass',
  // The stub plays a worker only: the verifier's rounds are verifier.test.ts's.
  verifier: { enabled: false },
}

/** A test's own folders, and its project's checkout on `main` with its settings and `files` committed. */
export const project = (
  projectSettings: object = settings,
  files: Readonly<Record<string, string>> = {},
) => {
  shared.counter += 1
  const base = join(shared.root, `t${shared.counter}`)
  const checkout = join(base, 'repo')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  commit(checkout, 'one', {
    'README.md': 'one\n',
    '.gitignore': '.fabrica/run/\n.fabrica/fabrica.log\n',
    '.fabrica/settings.json': `${JSON.stringify(projectSettings, null, 2)}\n`,
    'docs/spec.md':
      '# The spec\n\n## 13. The run\n\nRuns.\n\n### 13.2 Dispatch\n\nFree slots are filled at once.\n\n### 13.3 Ready\n\nOrchestra’s rule.\n',
    ...files,
  })
  return {
    checkout,
    data: join(base, 'data'),
    agents: join(base, 'agents'),
    sockets: join(shared.root, `s${shared.counter}`),
  }
}

export type Project = ReturnType<typeof project>

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${shared.bin}:${shared.gitFolder}:/usr/bin:/bin`,
    HOME: shared.home,
    LANG: 'C',
  },
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

/**
 * The process boundary's deadlines (a tree's kill grace, a command's output grace) on the live clock:
 * the stub and git are real processes, exiting in real time, while the run itself runs on TestClock.
 */
const liveDeadlines = Layer.succeed(Deadlines, {
  sleep: duration => TestClock.withLive(Effect.sleep(duration)),
})

/** The merge queue's waits (a refused fast-forward's retry, a dirty checkout's poll) on the live clock, as git's are. */
const liveMergeWaits = Layer.succeed(MergeWaits, {
  beforeRetry: TestClock.withLive(Effect.sleep('3 seconds')),
  poll: TestClock.withLive(Effect.sleep('2 seconds')),
})

const engine = EngineId.make('engine-1')
const maintainer: Actor = { _tag: 'maintainer' }
const run = RunId.make('run-1')

/** The provider's answer to a probe: it takes the key, or refuses it. */
type Answer = 'takes' | 'refuses'

/** A loopback Anthropic answering every call as `answer` says. */
const fakeProvider = (answer: Answer) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>(
      resume => {
        const server = createServer((request, response) => {
          request.resume()
          request.on('end', () => {
            if (answer === 'takes') {
              response.writeHead(200, {
                'content-type': anthropicAnswer.contentType,
              })
              response.end(anthropicAnswer.body)
            } else {
              response.writeHead(401, { 'content-type': 'application/json' })
              response.end(anthropicBadKey)
            }
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

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: name =>
    name === 'anthropic'
      ? Effect.succeed(Redacted.make('sk-ant-test-key'))
      : Effect.fail(new SecretMissing({ name })),
  remove: () => Effect.succeed(false),
})

const routesAt = (url: string): ReadonlyArray<ProviderRoute> => [
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

const attentionLayer = Layer.succeed(Attention)(
  Attention.of({
    permission: () =>
      Effect.succeed(PermissionDecision.cases.allow_run.make({})),
  }),
)

/** Every service a run runs on, live, over the boundaries' stand-ins. */
const services = (fixture: Project, provider: string) => {
  const runner = Layer.provideMerge(runnerLayer(runnerConfig()), liveDeadlines)
  const gitServices = Layer.provideMerge(
    worktreesLayer,
    Layer.provideMerge(gitLayer(gitConfig), runner),
  )
  const graph = Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
    Layer.provide(storeLayer(':memory:')),
  )
  const foundation = Layer.mergeAll(gitServices, graph)
  const proxy = Layer.effect(
    ModelProxy,
    makeProxy({ routes: routesAt(provider) }),
  ).pipe(Layer.provide(Layer.merge(Layer.succeed(Secrets)(secrets), layerOpen)))
  const middle = Layer.mergeAll(
    checksLayer,
    checkOwnPassesLayer,
    Layer.provide(layerWake, noSleepCauses),
    attentionLayer,
    liveMergeWaits,
    agentLayer({
      node: process.execPath,
      cli: shared.stub,
      extension: shared.extension,
      data: fixture.data,
      configRoot: fixture.agents,
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
    Layer.provide(
      layerRunLog({ root: fixture.checkout, run }),
      DateTime.layerCurrentZoneOffset(0),
    ),
  ).pipe(Layer.provideMerge(foundation))
  return controlLayer.pipe(Layer.provideMerge(middle))
}

export const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  mode: RunMode.Tickets(),
  limit: Option.none(),
  concurrent: Option.none(),
  ...overrides,
})

export const configOf = (
  fixture: Project,
  runOptions: RunOptions,
): RunConfig => ({
  project: ProjectId.make('p1'),
  engine,
  version: '0.0.0-test',
  checkout: fixture.checkout,
  home: besideCheckout(fixture.checkout),
  sockets: fixture.sockets,
  options: runOptions,
  settings: { flags: {}, environment: {}, engineSettings: {} },
  cores: 1,
  nice: Option.none(),
  projectTrusted: false,
})

/** Files a task whose stub does `script`. */
export const file = (title: string, script: string, extra: object = {}) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.create({
      ticket: { type: 'task', title, description: `stub: ${script}`, ...extra },
      actor: maintainer,
    }),
  )

/** The run's records, from its event stream. */
export const eventsOf = (fixture: Project) =>
  Effect.map(
    readEvents({ root: fixture.checkout, run: Option.some(run) }),
    read => read.events,
  )

export const ofKind = <K extends RunEvent['kind']>(
  events: ReadonlyArray<RunEvent>,
  kind: K,
): ReadonlyArray<Extract<RunEvent, { readonly kind: K }>> =>
  events.filter(
    (event): event is Extract<RunEvent, { readonly kind: K }> =>
      event.kind === kind,
  )

/**
 * Runs the project: `setup` files its tickets, `optionsOf` gives the run's flags from what it made,
 * and the provider answers every call; the run's end, its records, and what `setup` made.
 */
export const runOf = <A>(
  fixture: Project,
  setup: Effect.Effect<A, unknown, WorkGraph>,
  optionsOf: (made: A) => RunOptions = () => options(),
) =>
  Effect.gen(function* () {
    const provider = yield* fakeProvider('takes')
    return yield* Effect.gen(function* () {
      const made = yield* setup
      const end = yield* runProject(configOf(fixture, optionsOf(made)))
      const events = yield* eventsOf(fixture)
      const graph = yield* WorkGraph
      const all = yield* graph.list()
      const shown = new Map(
        yield* Effect.forEach(all, ticket =>
          Effect.map(
            graph.show(ticket.id),
            detail => [ticket.id, detail] as const,
          ),
        ),
      )
      /** The ticket as the work graph had it once the run ended. */
      const ticketOf = (id: TicketId) => {
        const detail = shown.get(id)
        if (detail === undefined) throw new Error(`no ticket ${id}`)
        return detail.ticket
      }
      return { end, events, ticketOf, made }
    }).pipe(Effect.provide(services(fixture, provider.url)))
  }).pipe(Effect.scoped)
