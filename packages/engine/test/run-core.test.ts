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
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Edge,
  EngineId,
  PermissionDecision,
  ProjectId,
  type RunEvent,
  RunId,
  type TicketId,
  TicketMetadata,
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
  worktreePath,
  worktreesLayer,
} from '../src/git'
import { MergeWaits, noSetup } from '../src/merge'
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

// The run loop's core as whole runs (spec §13, §13.1, §13.2, §13.5, §13.9, H78): the live PiAgent over
// a scripted Pi, real git in temp folders, the live control server, merge queue, checks and model
// proxy, on TestClock. The only stand-ins are at the boundary: Pi's CLI is a stub speaking its RPC
// protocol, which does what its ticket's description says (`stub: finish`, `stub: defer`, …) through
// the real control socket, and the model provider is a loopback server.

/**
 * A stub of `pi --mode rpc`. On its prompt it reads its ticket with `get_ticket` over the control
 * socket (Effect RPC's NDJSON protocol, the token in each request's headers) and does what the
 * ticket's `stub:` line says: `finish` (commits a file, runs `check_own`, finishes with its pass),
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-run-')))
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
  concurrent: 2,
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
    'docs/spec.md':
      '# The spec\n\n## 13. The run\n\nRuns.\n\n### 13.2 Dispatch\n\nFree slots are filled at once.\n\n### 13.3 Ready\n\nOrchestra’s rule.\n',
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

/** Every service a run runs on, live, over the boundaries' stand-ins; `probe` replaces the proxy's probe. */
const services = (
  fixture: Project,
  provider: string,
  probe?: ModelProxy['Service']['probe'],
) => {
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
    Effect.map(makeProxy({ routes: routesAt(provider) }), live =>
      probe === undefined ? live : ModelProxy.of({ ...live, probe }),
    ),
  ).pipe(Layer.provide(Layer.merge(Layer.succeed(Secrets)(secrets), layerOpen)))
  const middle = Layer.mergeAll(
    checksLayer,
    checkOwnPassesLayer,
    Layer.provide(layerWake, noSleepCauses),
    attentionLayer,
    noSetup,
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

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  mode: RunMode.Tickets(),
  limit: Option.none(),
  concurrent: Option.none(),
  ...overrides,
})

const configOf = (fixture: Project, runOptions: RunOptions): RunConfig => ({
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
const file = (title: string, script: string, extra: object = {}) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.create({
      ticket: { type: 'task', title, description: `stub: ${script}`, ...extra },
      actor: maintainer,
    }),
  )

/** The run's records, from its event stream. */
const eventsOf = (fixture: Project) =>
  Effect.map(
    readEvents({ root: fixture.checkout, run: Option.some(run) }),
    read => read.events,
  )

const ofKind = <K extends RunEvent['kind']>(
  events: ReadonlyArray<RunEvent>,
  kind: K,
): ReadonlyArray<Extract<RunEvent, { readonly kind: K }>> =>
  events.filter(
    (event): event is Extract<RunEvent, { readonly kind: K }> =>
      event.kind === kind,
  )

/** One entry of a stub's log. */
const StubEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
)

/** What a ticket's stub was prompted with, first prompt first. */
const promptsOf = (
  fixture: Project,
  ticket: TicketId,
): ReadonlyArray<string> => {
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
    .flatMap(entry =>
      entry.event === 'prompt' && entry.message !== undefined
        ? [entry.message]
        : [],
    )
}

/**
 * Runs the project: `setup` files its tickets, `optionsOf` gives the run's flags from what it made,
 * and the provider answers `answer`; the run's end, its records, and what `setup` made.
 */
const runOf = <A>(
  fixture: Project,
  setup: Effect.Effect<A, unknown, WorkGraph>,
  optionsOf: (made: A) => RunOptions = () => options(),
  answer: Answer = 'takes',
  probe?: ModelProxy['Service']['probe'],
) =>
  Effect.gen(function* () {
    const provider = yield* fakeProvider(answer)
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
    }).pipe(Effect.provide(services(fixture, provider.url, probe)))
  }).pipe(Effect.scoped)

const kinds = (events: ReadonlyArray<RunEvent>) =>
  events.map(event => event.kind)

describe('a run', () => {
  it.effect(
    'dispatches two tickets to two workers side by side and merges both',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { end, events, ticketOf, made } = yield* runOf(
          fixture,
          Effect.all([file('Add one', 'finish'), file('Add two', 'finish')]),
        )
        const ids = made.map(ticket => ticket.id)
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const seen = kinds(events)
        expect(seen[0]).toBe('info')
        expect(seen).toContain('start')
        const dispatches = ofKind(events, 'dispatch')
        expect(dispatches.map(({ ticket }) => ticket).sort()).toEqual(
          [...ids].sort(),
        )
        expect(dispatches.map(({ n }) => n)).toEqual([1, 2])
        // Both were dispatched before either settled: two workers at once.
        expect(seen.lastIndexOf('dispatch')).toBeLessThan(
          seen.indexOf('settled'),
        )
        expect(
          ofKind(events, 'closed')
            .map(({ ticket }) => ticket)
            .sort(),
        ).toEqual([...ids].sort())
        for (const id of ids) {
          const ticket = ticketOf(id)
          expect(ticket.status).toBe('closed')
          expect(Option.isSome(ticket.mergedCommit)).toBe(true)
          expect(existsSync(join(fixture.checkout, `${id}.txt`))).toBe(true)
          expect(promptsOf(fixture, id)[0]).toContain(`Your ticket is ${id}.`)
        }
        expect(ofKind(events, 'done')).toEqual([
          expect.objectContaining({
            detail: 'READY_EMPTY',
            text: 'READY_EMPTY after 2 tickets',
          }),
        ])
        expect(
          ofKind(events, 'ticket_end').map(({ outcome }) => outcome),
        ).toEqual(['merged', 'merged'])
        expect(seen.at(-1)).toBe('end')
        expect(ofKind(events, 'end')).toEqual([
          expect.objectContaining({ code: 0 }),
        ])
        // The end closed every session: no control socket is left.
        expect(
          existsSync(fixture.sockets) ? readdirSync(fixture.sockets) : [],
        ).toEqual([])
      }),
  )

  it.effect(
    "gives a ticket its earlier notes, its spec's cited sections and its dependencies' results",
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, concurrent: 1 })
        const { end, made } = yield* runOf(
          fixture,
          Effect.gen(function* () {
            const graph = yield* WorkGraph
            const api = yield* file('Build the API', 'finish')
            const client = yield* file('Build the client per §13.2', 'finish', {
              metadata: Schema.decodeUnknownSync(TicketMetadata)({
                spec: 'docs/spec.md',
              }),
            })
            yield* graph.addDependency({
              edge: new Edge({ from: api.id, to: client.id, kind: 'blocks' }),
              actor: maintainer,
            })
            yield* graph.note({
              id: client.id,
              body: 'An earlier attempt found the API missing.',
              actor: maintainer,
            })
            return { api: api.id, client: client.id }
          }),
        )
        expect(end.kind).toBe('READY_EMPTY')
        const prompt = promptsOf(fixture, made.client)[0] ?? ''
        expect(prompt).toContain(`Your ticket is ${made.client}.`)
        expect(prompt).toContain('An earlier attempt found the API missing.')
        expect(prompt).toContain(
          '### 13.2 Dispatch\n\nFree slots are filled at once.',
        )
        expect(prompt).not.toContain('13.3 Ready')
        expect(prompt).toContain(
          `${made.api} (Build the API): Built Build the API`,
        )
      }),
  )

  it.effect('sets a deferred ticket aside, its worktree kept', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events, ticketOf, made } = yield* runOf(
        fixture,
        file('Decide later', 'defer'),
      )
      const id = made.id
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(ticketOf(id).status).toBe('deferred')
      expect(ofKind(events, 'settled')).toEqual([
        expect.objectContaining({ ticket: id, outcome: 'defer' }),
      ])
      expect(ofKind(events, 'deferred')).toEqual([
        expect.objectContaining({
          ticket: id,
          reason: 'DEFERRED',
          detail: 'it needs a decision first',
        }),
      ])
      expect(ofKind(events, 'ticket_end')).toEqual([
        expect.objectContaining({
          ticket: id,
          outcome: 'set_aside',
          why: 'DEFERRED',
        }),
      ])
      expect(
        existsSync(
          worktreePath({ home: besideCheckout(fixture.checkout), ticket: id }),
        ),
      ).toBe(true)
      expect(ofKind(events, 'done')[0]?.text).toBe('READY_EMPTY after 1 ticket')
    }),
  )

  it.effect(
    'puts a ticket that waits for another back until it merges, its dispatch number reused',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { end, events, ticketOf, made } = yield* runOf(
          fixture,
          Effect.gen(function* () {
            const graphService = yield* WorkGraph
            const waiter = yield* file('Use the API', 'finish', { priority: 1 })
            const api = yield* file('Build the API', 'finish')
            yield* graphService.update({
              id: waiter.id,
              changes: { description: Option.some(`stub: wait_for ${api.id}`) },
              actor: maintainer,
            })
            return { waiter: waiter.id, api: api.id }
          }),
          () => options({ limit: Option.some(2) }),
        )
        expect(end).toEqual({ kind: 'LIMIT_REACHED', code: 0 })
        expect(ofKind(events, 'waits')).toEqual([
          expect.objectContaining({
            ticket: made.waiter,
            waits_for: [made.api],
            detail: 'its API',
          }),
        ])
        expect(
          ofKind(events, 'dispatch').map(({ ticket, n }) => [ticket, n]),
        ).toEqual([
          [made.waiter, 1],
          [made.api, 2],
          [made.waiter, 1],
        ])
        expect(ofKind(events, 'closed').map(({ ticket }) => ticket)).toEqual([
          made.api,
          made.waiter,
        ])
        expect(ticketOf(made.waiter).status).toBe('closed')
      }),
  )

  it.effect('waits on a question its worker asked about its own ticket', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events, made } = yield* runOf(
        fixture,
        file('Drop the flag', 'ask'),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      const asked = ofKind(events, 'asked')
      expect(asked).toEqual([
        expect.objectContaining({ ticket: made.id, title: 'Drop the flag' }),
      ])
      const question = asked[0]?.question
      expect(ofKind(events, 'ticket_end')).toEqual([
        expect.objectContaining({
          ticket: made.id,
          outcome: 'needs_you',
          why: question,
        }),
      ])
      const log = readFileSync(
        join(fixture.checkout, '.fabrica/fabrica.log'),
        'utf8',
      )
      expect(log).toContain(
        `QUESTIONS_WAITING: ${made.id} waits on the question ${question}`,
      )
    }),
  )

  it.effect('sets aside a ticket whose worker settled with no outcome', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { events } = yield* runOf(fixture, file('Say nothing', 'nothing'))
      expect(ofKind(events, 'settled')).toEqual([
        expect.objectContaining({ outcome: 'none' }),
      ])
      expect(ofKind(events, 'deferred')).toEqual([
        expect.objectContaining({ reason: 'UNFINISHED' }),
      ])
    }),
  )

  it.effect('stops dispatching at the limit, the rest left queued', () =>
    Effect.gen(function* () {
      const fixture = project({ ...settings, concurrent: 1 })
      const { end, events } = yield* runOf(
        fixture,
        Effect.all([
          file('First', 'finish'),
          file('Second', 'finish'),
          file('Third', 'finish'),
        ]),
        () => options({ limit: Option.some(1) }),
      )
      expect(end).toEqual({ kind: 'LIMIT_REACHED', code: 0 })
      expect(ofKind(events, 'dispatch')).toHaveLength(1)
      expect(ofKind(events, 'dispatch')[0]?.text).toMatch(/^\[1\/1\] fa-/u)
      expect(ofKind(events, 'done')[0]?.text).toBe(
        'LIMIT_REACHED after 1 ticket',
      )
      expect(
        ofKind(events, 'ticket_end')
          .map(({ outcome }) => outcome)
          .sort(),
      ).toEqual(['merged', 'queued', 'queued'])
    }),
  )

  it.effect('takes only the ticket and its descendants with --ticket', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { events, made } = yield* runOf(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const epic = yield* graph.create({
            ticket: { type: 'epic', title: 'The feature' },
            actor: maintainer,
          })
          const child = yield* graph.create({
            ticket: {
              type: 'task',
              title: 'Its part',
              description: 'stub: finish',
              parent: epic.id,
            },
            actor: maintainer,
          })
          const other = yield* file('Elsewhere', 'finish')
          return { epic: epic.id, child: child.id, other: other.id }
        }),
        made => options({ mode: RunMode.Ticket({ ticket: made.epic }) }),
      )
      expect(ofKind(events, 'dispatch').map(({ ticket }) => ticket)).toEqual([
        made.child,
      ])
      expect(ofKind(events, 'start')[0]?.scope).toBe(made.epic)
      expect(ofKind(events, 'closed').map(({ ticket }) => ticket)).toEqual([
        made.child,
      ])
    }),
  )

  it.effect('ends READY_EMPTY after 0 tickets when nothing is ready', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events } = yield* runOf(fixture, Effect.void)
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(ofKind(events, 'dispatch')).toEqual([])
      expect(ofKind(events, 'done')[0]?.text).toBe(
        'READY_EMPTY after 0 tickets',
      )
      expect(kinds(events).at(-1)).toBe('end')
    }),
  )
})

describe('the start checks', () => {
  it.effect(
    'list every problem together and end SETUP, exit 2, before the run starts',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, concurrent: 0 })
        writeFileSync(join(fixture.checkout, 'README.md'), 'changed\n')
        const { end, events } = yield* runOf(fixture, file('Never', 'finish'))
        expect(end).toEqual({ kind: 'SETUP', code: 2 })
        const problems = ofKind(events, 'warn').map(({ text }) => text)
        expect(problems).toHaveLength(2)
        expect(problems).toContainEqual(
          expect.stringContaining('has uncommitted changes: README.md'),
        )
        expect(problems).toContainEqual(
          expect.stringMatching(/^SETUP: .*concurrent/u),
        )
        expect(kinds(events)).not.toContain('start')
        expect(kinds(events)).not.toContain('dispatch')
        expect(ofKind(events, 'stop')).toEqual([
          expect.objectContaining({ detail: 'SETUP' }),
        ])
        expect(ofKind(events, 'end')).toEqual([
          expect.objectContaining({ code: 2 }),
        ])
        // Each check's end was streamed as it came.
        expect(ofKind(events, 'info').map(({ text }) => text)).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^start: the git check: git \d/u),
            'start: the credentials check: not checked: the settings have problems',
          ]),
        )
      }),
  )

  it.effect(
    "list a model's refused credential beside a detached checkout",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        git(fixture.checkout, 'checkout', '--quiet', '--detach')
        const { end, events } = yield* runOf(
          fixture,
          Effect.void,
          () => options(),
          'refuses',
        )
        expect(end).toEqual({ kind: 'SETUP', code: 2 })
        expect(ofKind(events, 'warn').map(({ text }) => text)).toEqual([
          expect.stringContaining("isn't on a branch"),
          expect.stringMatching(
            /^SETUP: anthropic\/claude-test: the credential was refused/u,
          ),
        ])
      }),
  )

  it.effect('list a defect inside a check as a problem line of its own', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events } = yield* runOf(
        fixture,
        Effect.void,
        () => options(),
        'takes',
        () => Effect.die(new Error('the probe broke')),
      )
      expect(end).toEqual({ kind: 'SETUP', code: 2 })
      expect(ofKind(events, 'warn').map(({ text }) => text)).toEqual([
        expect.stringMatching(
          /^SETUP: Internal error in the credentials check: .*the probe broke/u,
        ),
      ])
    }),
  )
})
