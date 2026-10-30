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

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  EngineId,
  ModelChoice,
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
  layerOpen,
  make as makeProxy,
} from '../src/proxy'
import { type RunConfig, RunMode, runProject } from '../src/run'
import { verifierModel, verifierTools } from '../src/run/verify'
import { layerRunLog, readEvents } from '../src/runlog'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import { layerWake, noBattery, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { anthropicAnswer } from './proxy-streams'

// The verifier after `finish` (spec §13.6, H19, H89) in whole runs: the live PiAgent over a scripted
// Pi, real git in temp folders, the live control server, merge queue, checks and model proxy, on
// TestClock. Pi's CLI is a stub playing both roles through the real control socket: as a worker it
// commits a file, runs check_own and finishes, and on a hand-back commits a fix and finishes again,
// or asks the maintainer where the hand-back says the rounds disagree; as the verifier
// (`FABRICA_AGENT_ROLE=verifier`) it gives, round by round, the verdicts its ticket's `verify:` line
// lists (`PASS`, `FAIL`, `DISAGREE`, or `none` for no verdict), the last one for every later round.

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
  const name = handedBack === null ? ticket.id + '.txt' : ticket.id + '-fix-' + handedBack[1] + '.txt'
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

let root = ''
let home = ''
let bin = ''
let gitFolder = ''
let stub = ''
let extension = ''
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

beforeAll(() => {
  // Short, so the control sockets' paths stay under the 103 bytes every platform takes.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ver-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'check-pass'), '#!/bin/sh\necho passing\n')
  chmodSync(join(bin, 'check-pass'), 0o755)
  stub = join(root, 'pi-stub.mjs')
  writeFileSync(stub, STUB)
  extension = join(root, 'extension.js')
  writeFileSync(extension, 'export default function () {}\n')
})

const settings = {
  concurrent: 1,
  model: 'anthropic/claude-test',
  check_own: 'check-pass',
  check_fast: 'check-pass',
}

/** A test's own folders, and its project's checkout on `main` with its settings committed. */
const project = (projectSettings: object = settings) => {
  counter += 1
  const base = join(root, `t${counter}`)
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
    sockets: join(root, `s${counter}`),
  }
}

type Project = ReturnType<typeof project>

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${bin}:${gitFolder}:/usr/bin:/bin`,
    HOME: home,
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
const maintainer: Actor = { _tag: 'maintainer' }
const run = RunId.make('run-1')

/** A loopback Anthropic taking every call. */
const fakeProvider = Effect.acquireRelease(
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
    noBattery,
    attentionLayer,
    liveMergeWaits,
    agentLayer({
      node: process.execPath,
      cli: stub,
      extension,
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

const configOf = (fixture: Project): RunConfig => ({
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
const entriesOf = (
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
const promptsOf = (
  entries: ReadonlyArray<StubEntry>,
  role: 'worker' | 'verifier',
): ReadonlyArray<StubEntry> =>
  entries.filter(entry => entry.role === role && entry.event === 'prompt')

const ofKind = <K extends RunEvent['kind']>(
  events: ReadonlyArray<RunEvent>,
  kind: K,
): ReadonlyArray<Extract<RunEvent, { readonly kind: K }>> =>
  events.filter(
    (event): event is Extract<RunEvent, { readonly kind: K }> =>
      event.kind === kind,
  )

/** The ticket's phase records, as `to (cause)`. */
const phasesOf = (events: ReadonlyArray<RunEvent>, ticket: TicketId) =>
  ofKind(events, 'phase')
    .filter(event => event.ticket === ticket)
    .map(event => `${event.to ?? 'out'} (${event.cause})`)

/** Runs the project with one ticket whose verifier gives `verify`: its end, records, ticket and stubs' log. */
const runOne = (fixture: Project, verify: string) =>
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
const wholeRun = 60_000

describe('the verifier', () => {
  it.effect(
    'passes a finished change to the merge queue, reusing its check_own pass on the same tree',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'PASS',
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(detail.ticket.status).toBe('closed')
        const phases = phasesOf(events, id)
        expect(phases.slice(0, 4)).toEqual([
          'queued (ready)',
          'working (dispatched)',
          'verifying (finished)',
          'waiting_to_merge (verified)',
        ])
        expect(phases.at(-1)).toBe('merged (merged into main)')
        const verifiers = promptsOf(entries, 'verifier')
        expect(verifiers).toHaveLength(1)
        const [verifier] = verifiers
        // Read-only: Pi's readers and bash, and its verdict.
        expect(verifier?.tools).toBe(verifierTools.join(','))
        expect(verifier?.tools).toBe('read,grep,find,ls,bash,verdict')
        expect(promptsOf(entries, 'worker')[0]?.tools).toBeNull()
        const prompt = verifier?.message ?? ''
        expect(prompt).toContain(`made for the ticket ${id}`)
        expect(prompt).toContain('round 1 of at most 3')
        expect(prompt).toContain(`The ticket, ${id}: Add the widget`)
        expect(prompt).toContain('Acceptance criteria:\nThe widget is there.')
        expect(prompt).toContain(`+++ b/${id}.txt`)
        expect(prompt).not.toContain("The earlier rounds' findings")
        // The worker's pass on the finished tree stands: the verifier is told so, its environment
        // names the tree, and check_own ran once, the worker's.
        const merged = Option.getOrThrow(detail.ticket.mergedCommit)
        const tree = git(fixture.checkout, 'rev-parse', `${merged}^{tree}`)
        expect(prompt).toContain(
          `The project's check_own passed on this tree, ${tree}`,
        )
        expect(prompt).toContain('Its results stand')
        expect(verifier?.passedAt).toBe(tree)
        expect(
          ofKind(events, 'check').filter(check => check.suite === 'own'),
        ).toHaveLength(1)
        // A worker's tool is refused to the verifier, a disagreement with no earlier round too, and
        // the verifier's tool to a worker.
        const exits = (role: string, tag: string) =>
          entries
            .filter(entry => entry.role === role && entry.tag === tag)
            .map(entry => entry.exit)
        expect(exits('verifier', 'add_note')).toEqual(['Failure'])
        expect(exits('verifier', 'verdict')).toEqual(['Failure', 'Success'])
        expect(exits('worker', 'verdict')).toEqual(['Failure'])
        expect(
          ofKind(events, 'info').some(event =>
            event.text.includes(`${id} verified in round 1 on ${tree}`),
          ),
        ).toBe(true)
      }),
    wholeRun,
  )

  it.effect(
    "hands a FAIL back to its worker's session with its findings, and passes the fix",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL,PASS',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(detail.ticket.status).toBe('closed')
        expect(phasesOf(events, id).slice(1, 6)).toEqual([
          'working (dispatched)',
          'verifying (finished)',
          'working (verifier round 1: FAIL)',
          'verifying (finished again)',
          'waiting_to_merge (verified)',
        ])
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(2)
        const handBack = workers[1]?.message ?? ''
        expect(handBack).toContain(
          `The verifier's round 1 of at most 3 found your change of ${id} not done`,
        )
        expect(handBack).toContain('Round 1: FAIL. A gap in round 1.')
        expect(handBack).toContain(
          '- [blocking] src/x.ts:1 has no test, round 1',
        )
        expect(handBack).toContain('finish again')
        // The hand-back resumed the worker's own session.
        expect(
          entries.filter(
            entry => entry.role === 'worker' && entry.event === 'switch',
          ),
        ).toEqual([expect.objectContaining({ path: workers[0]?.sessionFile })])
        // The second round weighs the first's findings.
        const verifiers = promptsOf(entries, 'verifier')
        expect(verifiers).toHaveLength(2)
        expect(verifiers[1]?.message).toContain('round 2 of at most 3')
        expect(verifiers[1]?.message).toContain("The earlier rounds' findings")
        expect(verifiers[1]?.message).toContain(
          '- [blocking] src/x.ts:1 has no test, round 1',
        )
        // The second round's pass is the fix's: its own tree, named to the verifier.
        const merged = Option.getOrThrow(detail.ticket.mergedCommit)
        const tree = git(fixture.checkout, 'rev-parse', `${merged}^{tree}`)
        expect(verifiers[1]?.passedAt).toBe(tree)
        expect(verifiers[0]?.passedAt).not.toBe(tree)
        expect(existsSync(join(fixture.checkout, `${id}-fix-1.txt`))).toBe(true)
        expect(detail.notes.map(note => note.body)).toContain(
          'Verifier Round 1: FAIL. A gap in round 1.\n- [blocking] src/x.ts:1 has no test, round 1',
        )
        expect(
          ofKind(events, 'warn').map(event => event.text.trim()),
        ).toContain(
          `VERIFIER_FAIL: ${id} verifier round 1: FAIL: A gap in round 1.`,
        )
        expect(ofKind(events, 'settled').map(({ outcome }) => outcome)).toEqual(
          ['finish', 'finish'],
        )
      }),
    wholeRun,
  )

  it.effect(
    'stops at verifier.rounds: the last FAIL goes back, and the finish after it merges unverified',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, verifier: { rounds: 2 } })
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(promptsOf(entries, 'verifier')).toHaveLength(2)
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(3)
        expect(workers[1]?.message).toContain('finish again')
        const last = workers[2]?.message ?? ''
        expect(last).toContain("The verifier's round 2 of at most 2")
        expect(last).toContain('That was the last round')
        expect(last).toContain("The earlier rounds' findings")
        expect(last).toContain('src/x.ts:1 has no test, round 1')
        expect(phasesOf(events, id)).toContain(
          "waiting_to_merge (finished past the verifier's last round, 2)",
        )
        expect(detail.ticket.status).toBe('closed')
        expect(
          detail.notes.filter(note => note.body.startsWith('Verifier Round')),
        ).toHaveLength(2)
      }),
    wholeRun,
  )

  it.effect(
    'hands a round that disagrees with an earlier one back for the worker to ask the maintainer',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL,DISAGREE',
        )
        // No third round: the worker asked instead.
        expect(promptsOf(entries, 'verifier')).toHaveLength(2)
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(3)
        const asking = workers[2]?.message ?? ''
        expect(asking).toContain(
          `The verifier's round 2 on ${id} disagrees with round 1:`,
        )
        expect(asking).toContain(
          '- [blocking] DISAGREES WITH ROUND 1: the ticket asks for no such test',
        )
        expect(asking).toContain('src/x.ts:1 has no test, round 1')
        expect(asking).toContain('ask the maintainer which holds')
        expect(phasesOf(events, id)).toContain(
          'working (verifier round 2 disagrees with round 1)',
        )
        expect(ofKind(events, 'asked')).toEqual([
          expect.objectContaining({ ticket: id }),
        ])
        expect(detail.ticket.status).not.toBe('closed')
      }),
    wholeRun,
  )

  it.effect(
    'sets aside a change its verifier gave no verdict on',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, events, detail } = yield* runOne(fixture, 'none')
        expect(phasesOf(events, id)).toContain(
          'set_aside (its verifier settled with no verdict in round 1)',
        )
        expect(detail.ticket.status).toBe('deferred')
      }),
    wholeRun,
  )

  it.effect(
    'is skipped where verifier.enabled is false: a finish goes to the merge queue',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, verifier: { enabled: false } })
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(detail.ticket.status).toBe('closed')
        expect(promptsOf(entries, 'verifier')).toEqual([])
        expect(phasesOf(events, id)).toContain('waiting_to_merge (finished)')
        expect(
          phasesOf(events, id).some(phase => phase.startsWith('verifying')),
        ).toBe(false)
      }),
    wholeRun,
  )
})

describe("the verifier's model", () => {
  const choice = (written: string) =>
    Schema.decodeUnknownSync(ModelChoice)(written)
  const worker = Option.some({ provider: 'anthropic', modelId: 'claude-x' })

  it('is verifier.model where it is set', () => {
    expect(
      verifierModel({
        verifier: Option.some(choice('anthropic/claude-y')),
        configured: [choice('openai/gpt-z')],
        worker,
      }),
    ).toEqual(Option.some({ provider: 'anthropic', modelId: 'claude-y' }))
  })

  it("is else a configured model of another provider than the worker's", () => {
    expect(
      verifierModel({
        verifier: Option.none(),
        configured: [
          choice('anthropic/claude-x'),
          choice('openai/gpt-z'),
          choice('google/gemini-w'),
        ],
        worker,
      }),
    ).toEqual(Option.some({ provider: 'openai', modelId: 'gpt-z' }))
  })

  it("is else the worker's own", () => {
    expect(
      verifierModel({
        verifier: Option.none(),
        configured: [choice('anthropic/claude-x')],
        worker,
      }),
    ).toEqual(worker)
  })
})
