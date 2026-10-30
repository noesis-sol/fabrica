import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

import { layer as agentLayer, sessionFolder } from '../src/agent'
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
  layerHeld,
  make as makeProxy,
} from '../src/proxy'
import { type RunConfig, RunMode, runProject } from '../src/run'
import { layerRunLog, readEvents } from '../src/runlog'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import { layerWake, noBattery, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { anthropicAnswer } from './proxy-streams'
import { noTelemetry } from './run-harness'

// The verifier's whole runs (spec §13.6, H19, H89), shared by its test files: the live PiAgent over
// a scripted Pi, real git in temp folders, the live control server, merge queue, checks and model
// proxy, on TestClock. Pi's CLI is a stub playing both roles through the real control socket: as a
// worker it commits a file, runs check_own and finishes, on a hand-back commits a fix and finishes
// again, or asks the maintainer where the hand-back says the rounds disagree, and resumed commits
// another file and finishes; as the verifier (`FABRICA_AGENT_ROLE=verifier`) it gives, round by
// round, the verdicts its ticket's `verify:` line lists (`PASS`, `FAIL`, `DISAGREE`, or `none` for
// no verdict), the last one for every later round.

const STUB = `import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const tools = args.includes('--tools') ? args[args.indexOf('--tools') + 1] : null
const role = process.env.FABRICA_AGENT_ROLE ?? 'worker'
const passedAt = process.env.FABRICA_CHECK_OWN_PASSED_AT ?? null
const note = entry => appendFileSync(join(sessions, 'stub.jsonl'), JSON.stringify({ role, ...entry }) + '\\n')
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const sessionId = 's-' + process.pid
let sessionFile = join(sessions, sessionId + '.jsonl')
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
const tryCall = (tag, payload) =>
  new Promise(resolve => {
    const id = String(next++)
    waiting.set(id, resolve)
    control().write(JSON.stringify({
      _tag: 'Request', id, tag, payload,
      headers: [['x-fabrica-control-token', process.env.FABRICA_CONTROL_TOKEN]],
    }) + '\\n')
  }).then(exit => {
    note({ event: 'call', tag, exit: exit._tag })
    return exit
  })
const call = (tag, payload) =>
  tryCall(tag, payload).then(exit => {
    if (exit._tag !== 'Success') throw new Error(tag + ' failed: ' + JSON.stringify(exit))
    return exit.value
  })
const git = (...words) => execFileSync('git', words, { encoding: 'utf8' }).trim()
const verdictOf = (word, round) => {
  if (word === 'PASS') return { _tag: 'PASS', summary: 'It meets its ticket.', findings: [] }
  if (word === 'DISAGREE')
    return {
      _tag: 'FAIL',
      summary: 'Round 1 misread the ticket.',
      findings: [{ gap: 'the ticket asks for no such test', blocking: true, disagreesWithRound: 1 }],
    }
  return {
    _tag: 'FAIL',
    summary: 'A gap in round ' + round + '.',
    findings: [{ gap: 'src/x.ts:1 has no test, round ' + round, blocking: true }],
  }
}
const verify = async message => {
  // A worker's tool is refused to the verifier, and so is a round disagreeing with itself.
  await tryCall('add_note', { body: 'the verifier writes nothing' })
  await tryCall('verdict', {
    verdict: { _tag: 'FAIL', summary: 'Itself.', findings: [{ gap: 'x', blocking: true, disagreesWithRound: 99 }] },
  })
  const view = await call('get_ticket', {})
  const script = ((view.ticket.description ?? '').match(/verify: (.*)/)?.[1] ?? 'PASS').split(',')
  const round = Number(message.match(/round (\\d+) of at most/)?.[1] ?? '1')
  const word = script[Math.min(round, script.length) - 1]
  if (word === 'none') return
  return call('verdict', { verdict: verdictOf(word, round) })
}
const work = async message => {
  if (role === 'verifier') return verify(message)
  // The verifier's tool is refused to a worker.
  await tryCall('verdict', { verdict: { _tag: 'PASS', summary: 'Mine.', findings: [] } })
  const view = await call('get_ticket', {})
  const ticket = view.ticket
  if (/disagrees with round/.test(message))
    return call('ask_question', {
      title: 'Which round holds?',
      description: 'Round 1 asks for a test; round 2 says the ticket asks for none.',
      choices: { options: [{ label: 'Round 1', tradeOff: 'One more test.' }, { label: 'Round 2', tradeOff: 'Nothing more.' }], recommended: 1 },
      consequential: false,
      maintainerOnly: false,
    })
  const handedBack = message.match(/The verifier's round (\\d+)/)
  const name =
    handedBack !== null
      ? ticket.id + '-fix-' + handedBack[1] + '.txt'
      : / is resumed: /.test(message)
        ? ticket.id + '-resumed.txt'
        : ticket.id + '.txt'
  writeFileSync(name, ticket.title + '\\n')
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
    case 'switch_session':
      sessionFile = command.sessionPath
      note({ event: 'switch', path: command.sessionPath })
      return respond(command.id, 'switch_session', { cancelled: false })
    case 'prompt':
      respond(command.id, 'prompt', { disposition: 'started' })
      note({ event: 'prompt', message: command.message, sessionFile, passedAt, tools })
      out({ type: 'agent_start' })
      return work(command.message)
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

/** The fixtures' folders, written by `setUpFixtures`, and the tests' projects counted. */
const fixtures = {
  root: '',
  home: '',
  bin: '',
  gitFolder: '',
  stub: '',
  extension: '',
  counter: 0,
}

const fixtureEnv = () => ({
  PATH: `${fixtures.gitFolder}:/usr/bin:/bin`,
  HOME: fixtures.home,
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
const commit = (
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

/** Writes the fixtures every test shares: a home with git's config, the check, the Pi stub. Once, before the tests. */
export const setUpFixtures = () => {
  // Short, so the control sockets' paths stay under the 103 bytes every platform takes.
  fixtures.root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ver-')))
  fixtures.home = join(fixtures.root, 'home')
  mkdirSync(fixtures.home)
  writeFileSync(
    join(fixtures.home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  fixtures.gitFolder = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
  }).trim()
  fixtures.bin = join(fixtures.root, 'bin')
  mkdirSync(fixtures.bin)
  writeFileSync(join(fixtures.bin, 'check-pass'), '#!/bin/sh\necho passing\n')
  chmodSync(join(fixtures.bin, 'check-pass'), 0o755)
  fixtures.stub = join(fixtures.root, 'pi-stub.mjs')
  writeFileSync(fixtures.stub, STUB)
  fixtures.extension = join(fixtures.root, 'extension.js')
  writeFileSync(fixtures.extension, 'export default function () {}\n')
}

export const settings = {
  concurrent: 1,
  model: 'anthropic/claude-test',
  check_own: 'check-pass',
  check_fast: 'check-pass',
}

/** A test's own folders, and its project's checkout on `main` with its settings committed. */
export const project = (projectSettings: object = settings) => {
  fixtures.counter += 1
  const base = join(fixtures.root, `t${fixtures.counter}`)
  const checkout = join(base, 'repo')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  commit(checkout, 'one', {
    'README.md': 'one\n',
    '.gitignore': '.fabrica/run/\n.fabrica/fabrica.log\n',
    '.fabrica/settings.json': `${JSON.stringify(projectSettings, null, 2)}\n`,
  })
  return {
    checkout,
    data: join(base, 'data'),
    agents: join(base, 'agents'),
    sockets: join(fixtures.root, `s${fixtures.counter}`),
  }
}

export type Project = ReturnType<typeof project>

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${fixtures.bin}:${fixtures.gitFolder}:/usr/bin:/bin`,
    HOME: fixtures.home,
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

/** The process boundary's deadlines on the live clock: the stub and git exit in real time. */
const liveDeadlines = Layer.succeed(Deadlines, {
  sleep: duration => TestClock.withLive(Effect.sleep(duration)),
})

/** The merge queue's waits on the live clock, as git's are. */
const liveMergeWaits = Layer.succeed(MergeWaits, {
  beforeRetry: TestClock.withLive(Effect.sleep('3 seconds')),
  poll: TestClock.withLive(Effect.sleep('2 seconds')),
})

const engine = EngineId.make('engine-1')
export const maintainer: Actor = { _tag: 'maintainer' }
export const run = RunId.make('run-1')

/** A loopback Anthropic taking every call. */
export const fakeProvider = Effect.acquireRelease(
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
export const services = (fixture: Project, provider: string) => {
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
  ).pipe(
    Layer.provide(Layer.succeed(Secrets)(secrets)),
    Layer.provideMerge(layerHeld),
  )
  const middle = Layer.mergeAll(
    checksLayer,
    checkOwnPassesLayer,
    Layer.provide(layerWake, noSleepCauses),
    noBattery,
    noTelemetry,
    attentionLayer,
    liveMergeWaits,
    agentLayer({
      node: process.execPath,
      cli: fixtures.stub,
      extension: fixtures.extension,
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
    Layer.provideMerge(
      layerRunLog({ root: fixture.checkout, run }),
      DateTime.layerCurrentZoneOffset(0),
    ),
  ).pipe(Layer.provideMerge(foundation))
  return controlLayer.pipe(Layer.provideMerge(middle))
}

export const configOf = (fixture: Project): RunConfig => ({
  project: ProjectId.make('p1'),
  engine,
  version: '0.0.0-test',
  checkout: fixture.checkout,
  home: besideCheckout(fixture.checkout),
  sockets: fixture.sockets,
  options: {
    mode: RunMode.Tickets(),
    limit: Option.none(),
    concurrent: Option.none(),
  },
  settings: { flags: {}, environment: {}, engineSettings: {} },
  cores: 1,
  nice: Option.none(),
  // A host with no inhibitor: no sleep to prevent.
  keepAwakeHost: { platform: 'aix', pid: 1 },
  projectTrusted: false,
})

/** One entry of a stub's log. */
const StubEntry = Schema.fromJsonString(
  Schema.Struct({
    role: Schema.String,
    event: Schema.String,
    message: Schema.optionalKey(Schema.String),
    sessionFile: Schema.optionalKey(Schema.String),
    passedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    tools: Schema.optionalKey(Schema.NullOr(Schema.String)),
    path: Schema.optionalKey(Schema.String),
    tag: Schema.optionalKey(Schema.String),
    exit: Schema.optionalKey(Schema.String),
  }),
)
type StubEntry = typeof StubEntry.Type

/** Every entry of the ticket's stubs' logs, the worker's and the verifier's, in order. */
export const entriesOf = (
  fixture: Project,
  ticket: TicketId,
): ReadonlyArray<StubEntry> => {
  const log = join(
    sessionFolder({
      data: fixture.data,
      project: ProjectId.make('p1'),
      ticket,
    }),
    'stub.jsonl',
  )
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => Schema.decodeUnknownSync(StubEntry)(line))
}

/** The prompts of the ticket's agents in `role`, first first. */
export const promptsOf = (
  entries: ReadonlyArray<StubEntry>,
  role: 'worker' | 'verifier',
): ReadonlyArray<StubEntry> =>
  entries.filter(entry => entry.role === role && entry.event === 'prompt')

export const ofKind = <K extends RunEvent['kind']>(
  events: ReadonlyArray<RunEvent>,
  kind: K,
): ReadonlyArray<Extract<RunEvent, { readonly kind: K }>> =>
  events.filter(
    (event): event is Extract<RunEvent, { readonly kind: K }> =>
      event.kind === kind,
  )

/** The ticket's phase records, as `to (cause)`. */
export const phasesOf = (events: ReadonlyArray<RunEvent>, ticket: TicketId) =>
  ofKind(events, 'phase')
    .filter(event => event.ticket === ticket)
    .map(event => `${event.to ?? 'out'} (${event.cause})`)

/** Runs the project with one ticket whose verifier gives `verify`: its end, records, ticket and stubs' log. */
export const runOne = (fixture: Project, verify: string) =>
  Effect.gen(function* () {
    const provider = yield* fakeProvider
    return yield* Effect.gen(function* () {
      const graph = yield* WorkGraph
      const made = yield* graph.create({
        ticket: {
          type: 'task',
          title: 'Add the widget',
          description: `Adds the widget.\n\nverify: ${verify}`,
          acceptance: 'The widget is there.',
        },
        actor: maintainer,
      })
      const end = yield* runProject(configOf(fixture))
      const { events } = yield* readEvents({
        root: fixture.checkout,
        run: Option.some(run),
      })
      const detail = yield* graph.show(made.id)
      return {
        id: made.id,
        end,
        events,
        detail,
        entries: entriesOf(fixture, made.id),
      }
    }).pipe(Effect.provide(services(fixture, provider.url)))
  }).pipe(Effect.scoped)

/** A whole run's limit: up to five Pi sessions in turn, beside every other test file. */
export const wholeRun = 60_000
