import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  type Scope,
  Stream,
} from 'effect'
import { RpcClient, RpcMiddleware, RpcSerialization } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
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
  ControlSocketVariable,
  ControlToken,
  ControlTokenVariable,
  Edge,
  PermissionDecision,
  PermissionShown,
  ProjectId,
  QuestionChoices,
  QuestionOption,
  SessionId,
  TicketId,
  TicketMetadata,
  TicketResult,
  ToolCallId,
  TreeHash,
  WorkerTools,
  controlTokenClient,
} from '@fabrica/contracts'

import { layer as checksLayer } from '../src/checks'
import {
  type AgentControl,
  Attention,
  CheckOwnPasses,
  type CheckOwnRun,
  ControlServer,
  Outcome,
  type PermissionRequest,
  checkOwnPassesLayer,
  layer as controlLayer,
  inScope,
} from '../src/control'
import { Git, type GitConfig, layer as gitLayer } from '../src/git'
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

// The agent control server (spec §12.2, §12.3, §20.2) over a real Unix socket: a client speaking the
// control group with the session's token, against an in-memory work graph and a real git repository
// in a temp folder. The client runs on the live clock, so its pings don't fire as a test moves
// `TestClock`; the server, its question wait among it, runs on `TestClock`.

let root = ''
let home = ''
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

/** A new repository on `main` with one commit, and a folder for its sockets beside it. */
const fixture = () => {
  counter += 1
  const worktree = join(root, `repo-${counter}`)
  mkdirSync(worktree)
  git(worktree, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(worktree, 'README.md'), 'one\n')
  git(worktree, 'add', '--all')
  git(worktree, 'commit', '--quiet', '--message', 'one')
  return { worktree, folder: join(root, `sockets-${counter}`) }
}

const head = (worktree: string) => ({
  commit: CommitHash.make(git(worktree, 'rev-parse', 'HEAD')),
  tree: TreeHash.make(git(worktree, 'rev-parse', 'HEAD^{tree}')),
})

beforeAll(() => {
  // Short, so the sockets' paths stay under the 103 bytes every platform takes.
  root = mkdtempSync(join(tmpdir(), 'fab-ctl-'))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: { PATH: `${gitFolder}:/usr/bin:/bin`, HOME: home },
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
  readRetries: { times: 2, spacing: Duration.zero },
}

/** The permission requests the attention port was given, each answered `allow_run`. */
class AskedPermissions extends Context.Service<
  AskedPermissions,
  Queue.Queue<PermissionRequest>
>()('test/AskedPermissions') {}

const attentionLayer = Layer.effect(
  Attention,
  Effect.map(AskedPermissions, asked =>
    Attention.of({
      permission: request =>
        Effect.as(
          Queue.offer(asked, request),
          PermissionDecision.cases.allow_run.make({}),
        ),
    }),
  ),
)

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const runnerServiceLayer = Layer.provide(
  runnerLayer(runnerConfig()),
  layerClock,
)

const gitServiceLayer = Layer.provide(gitLayer(gitConfig), runnerServiceLayer)

const services = controlLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      graphLayer,
      gitServiceLayer,
      Layer.provide(
        checksLayer,
        Layer.merge(runnerServiceLayer, gitServiceLayer),
      ),
      Layer.provide(layerWake, noSleepCauses),
      checkOwnPassesLayer,
      attentionLayer,
    ),
  ),
  Layer.provideMerge(
    Layer.effect(AskedPermissions, Queue.unbounded<PermissionRequest>()),
  ),
)

const project = ProjectId.make('project-1')
const session = SessionId.make('session-1')
const maintainer: Actor = { _tag: 'maintainer' }

/** A client of the control group on `socket`, its requests carrying `token`, on the live clock. */
const connect = (
  socket: string,
  clientToken: Layer.Layer<RpcMiddleware.ForClient<ControlToken>>,
) =>
  TestClock.withLive(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(NodeSocket.layerNet({ path: socket })),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
          clientToken,
        ),
      )
      return yield* Effect.provide(RpcClient.make(ControlRpcs), context)
    }),
  )

const withToken = (control: AgentControl) =>
  controlTokenClient(control.environment[ControlTokenVariable] ?? '')

/** A project that sets no `check_own`, its logs kept under `checkout`. */
const noCheckOwn = (checkout: string): CheckOwnRun => ({
  command: CommandSetting.cases.Unset.make({}),
  checkout,
  timeLimit: Duration.minutes(1),
  cores: 1,
  nice: Option.none(),
})

/** The services, a ticket of its own and its control channel open, with a client holding its token. */
const harness = Effect.gen(function* () {
  const { worktree, folder } = fixture()
  const graph = yield* WorkGraph
  const own = yield* graph.create({
    ticket: { type: 'task', title: 'Build the control server' },
    actor: maintainer,
  })
  const control = yield* (yield* ControlServer).open({
    project,
    ticket: own.id,
    session,
    worktree,
    folder,
    questionWait: Duration.minutes(15),
    checkOwn: noCheckOwn(folder),
  })
  const client = yield* connect(control.socket, withToken(control))
  /** The next outcome the session published. */
  const nextOutcome = Effect.map(
    Stream.runCollect(Stream.take(control.outcomes, 1)),
    outcomes => outcomes[0],
  )
  return { worktree, folder, graph, own: own.id, control, client, nextOutcome }
})

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Scope.Scope
    | WorkGraph
    | Git
    | ControlServer
    | CheckOwnPasses
    | AskedPermissions
  >,
) => Effect.scoped(body).pipe(Effect.provide(services))

const choices = new QuestionChoices({
  options: [
    new QuestionOption({ label: 'Keep it', tradeOff: 'Nothing changes.' }),
    new QuestionOption({ label: 'Drop it', tradeOff: 'Less to maintain.' }),
  ],
  recommended: 0,
})

const asking = {
  title: 'Keep the old flag?',
  description: 'The flag is read nowhere now; keeping it costs a line.',
  choices,
  consequential: false,
  maintainerOnly: false,
  blocks: Option.none<TicketId>(),
}

describe('the control group', () => {
  it('serves every worker tool', () => {
    const tags = [...ControlRpcs.requests.keys()]
    for (const tool of WorkerTools) expect(tags).toContain(tool.name)
  })
})

describe('the socket and its token', () => {
  it.effect(
    'opens a socket of mode 0600 in a folder of mode 0700, named in the environment',
    () =>
      run(
        Effect.gen(function* () {
          const { control, folder } = yield* harness
          expect(control.environment[ControlSocketVariable]).toBe(
            control.socket,
          )
          expect(statSync(control.socket).isSocket()).toBe(true)
          expect(statSync(control.socket).mode & 0o777).toBe(0o600)
          expect(statSync(folder).mode & 0o777).toBe(0o700)
        }),
      ),
  )

  it.effect('removes the socket once the session closes', () =>
    run(
      Effect.gen(function* () {
        const socket = yield* Effect.scoped(
          Effect.map(harness, ({ control }) => control.socket),
        )
        expect(existsSync(socket)).toBe(false)
      }),
    ),
  )

  it.effect('refuses a request with another session’s token, or none', () =>
    run(
      Effect.gen(function* () {
        const { control, graph } = yield* harness
        const other = yield* graph.create({
          ticket: { type: 'task', title: 'Another ticket' },
          actor: maintainer,
        })
        const otherControl = yield* (yield* ControlServer).open({
          project,
          ticket: other.id,
          session: SessionId.make('session-2'),
          worktree: fixture().worktree,
          folder: fixture().folder,
          questionWait: Duration.minutes(15),
          checkOwn: noCheckOwn(root),
        })
        const stranger = yield* connect(control.socket, withToken(otherControl))
        const refused = yield* Effect.flip(
          stranger.get_ticket({ id: Option.none() }),
        )
        expect(refused._tag).toBe('ControlUnauthorized')

        const bare = yield* connect(
          control.socket,
          RpcMiddleware.layerClient(ControlToken, ({ request, next }) =>
            next(request),
          ),
        )
        const unsent = yield* Effect.flip(
          bare.get_ticket({ id: Option.none() }),
        )
        expect(unsent._tag).toBe('ControlUnauthorized')
      }),
    ),
  )

  it.effect('reaches its own ticket and those linked to it, no other', () =>
    run(
      Effect.gen(function* () {
        const { client, graph, own } = yield* harness
        const elsewhere = yield* graph.create({
          ticket: { type: 'task', title: 'Elsewhere' },
          actor: maintainer,
        })
        const refused = yield* Effect.flip(
          client.get_ticket({ id: Option.some(elsewhere.id) }),
        )
        expect(refused).toEqual({ _tag: 'out_of_scope', ticket: elsewhere.id })
        const notAsked = yield* Effect.flip(
          client.ask_question({ ...asking, blocks: Option.some(elsewhere.id) }),
        )
        expect(notAsked).toEqual({
          _tag: 'out_of_scope',
          ticket: elsewhere.id,
        })

        yield* graph.addDependency({
          edge: new Edge({ from: elsewhere.id, to: own, kind: 'related' }),
          actor: maintainer,
        })
        const view = yield* client.get_ticket({
          id: Option.some(elsewhere.id),
        })
        expect(view.ticket.id).toBe(elsewhere.id)
      }),
    ),
  )

  it('takes a linked ticket either way as in scope', () => {
    const own = TicketId.make('fa-own')
    const other = TicketId.make('fa-other')
    const third = TicketId.make('fa-third')
    const edges = [new Edge({ from: other, to: own, kind: 'blocks' })]
    expect(inScope({ own, edges, target: own })).toBe(true)
    expect(inScope({ own, edges, target: other })).toBe(true)
    expect(inScope({ own: other, edges, target: own })).toBe(true)
    expect(inScope({ own, edges, target: third })).toBe(false)
  })
})

describe('get_ticket', () => {
  it.effect(
    'shows the ticket with its notes and the results of its blockers',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own } = yield* harness
          const blocker = yield* graph.create({
            ticket: { type: 'task', title: 'The contract' },
            actor: maintainer,
          })
          const result = TicketResult.cases.decision_recorded.make({
            summary: 'Added the schema.',
            decision: 'Tokens are hex.',
          })
          yield* graph.update({
            id: blocker.id,
            changes: { result: Option.some(result) },
            actor: maintainer,
          })
          yield* graph.addDependency({
            edge: new Edge({ from: blocker.id, to: own, kind: 'blocks' }),
            actor: maintainer,
          })
          yield* graph.note({ id: own, body: 'Read §12.3', actor: maintainer })

          const view = yield* client.get_ticket({ id: Option.none() })
          expect(view.ticket.id).toBe(own)
          expect(view.notes.map(note => note.body)).toEqual(['Read §12.3'])
          expect(view.dependencies).toHaveLength(1)
          expect(view.dependencies[0]?.id).toBe(blocker.id)
          expect(view.dependencies[0]?.result).toEqual(Option.some(result))
        }),
      ),
  )
})

describe('file_ticket', () => {
  it.effect(
    'files a follow-up blocked by the ticket, its files as its footprint',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own } = yield* harness
          const filed = yield* client.file_ticket({
            title: 'Serve the gate’s decisions',
            description: 'The gate reports each decision for the reviewer.',
            type: 'task',
            priority: Option.some(1),
            files: ['packages/engine/src/control/tools.ts'],
            labels: Option.some(['solo']),
            link: 'blocks',
          })
          const detail = yield* graph.show(filed.id)
          expect(detail.ticket.priority).toBe(1)
          expect(detail.labels).toEqual(['solo'])
          expect(detail.ticket.metadata.files).toEqual(
            Option.some(['packages/engine/src/control/tools.ts']),
          )
          expect(detail.edges).toContainEqual(
            new Edge({ from: own, to: filed.id, kind: 'blocks' }),
          )
        }),
      ),
  )

  it.effect('files a discovered issue with unknown files, linked from it', () =>
    run(
      Effect.gen(function* () {
        const { client, graph, own } = yield* harness
        const filed = yield* client.file_ticket({
          title: 'Flaky store test',
          description: 'The store test failed once on a busy machine.',
          type: 'bug',
          priority: Option.none(),
          files: 'unknown',
          labels: Option.none(),
          link: 'discovered_from',
        })
        const detail = yield* graph.show(filed.id)
        expect(detail.ticket.priority).toBe(2)
        expect(detail.ticket.metadata).toEqual(
          Schema.decodeSync(TicketMetadata)({}),
        )
        expect(detail.edges).toContainEqual(
          new Edge({ from: filed.id, to: own, kind: 'discovered_from' }),
        )
      }),
    ),
  )
})

describe('ask_question and add_note', () => {
  it.effect(
    'asks about its own ticket: the question blocks it and ends the turn',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own, nextOutcome } = yield* harness
          const filed = yield* client.ask_question(asking)
          const question = yield* graph.show(filed.id)
          expect(question.ticket.type).toBe('question')
          expect(question.edges).toContainEqual(
            new Edge({ from: filed.id, to: own, kind: 'blocks' }),
          )
          expect(question.edges).toContainEqual(
            new Edge({ from: filed.id, to: own, kind: 'discovered_from' }),
          )
          expect(yield* nextOutcome).toEqual(
            Outcome.Asked({ question: filed.id }),
          )
        }),
      ),
  )

  it.effect(
    'asks about a linked ticket: the question blocks that one, and the turn goes on',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own, nextOutcome } = yield* harness
          const linked = yield* graph.create({
            ticket: { type: 'task', title: 'A follow-up' },
            actor: maintainer,
          })
          yield* graph.addDependency({
            edge: new Edge({ from: own, to: linked.id, kind: 'blocks' }),
            actor: maintainer,
          })
          const filed = yield* client.ask_question({
            ...asking,
            blocks: Option.some(linked.id),
          })
          const question = yield* graph.show(filed.id)
          expect(question.edges).toContainEqual(
            new Edge({ from: filed.id, to: linked.id, kind: 'blocks' }),
          )
          // The next outcome is the one reported after, not an `Asked`.
          yield* client.report_unfinished({})
          expect(yield* nextOutcome).toEqual(Outcome.Unfinished())
        }),
      ),
  )

  it.effect('writes a note on its own ticket', () =>
    run(
      Effect.gen(function* () {
        const { client, graph, own } = yield* harness
        const noted = yield* client.add_note({ body: 'Chose hex tokens.' })
        const { notes } = yield* graph.show(own)
        expect(notes.map(note => [note.id, note.body])).toEqual([
          [noted.id, 'Chose hex tokens.'],
        ])
        expect(notes[0]?.author).toEqual({ _tag: 'worker', session })
      }),
    ),
  )
})

describe('finish', () => {
  const summary = TicketResult.cases.summary.make({ summary: 'Built it.' })

  it.effect('is refused with the untracked files named', () =>
    run(
      Effect.gen(function* () {
        const { client, worktree } = yield* harness
        writeFileSync(join(worktree, 'scratch.txt'), 'left behind\n')
        const refused = yield* Effect.flip(
          client.finish({
            checkOwn: new CheckOwnPass({ ...head(worktree), output: 'log' }),
            result: summary,
          }),
        )
        expect(refused).toEqual({
          _tag: 'worktree_dirty',
          uncommitted: [],
          untracked: ['scratch.txt'],
        })
      }),
    ),
  )

  it.effect('is refused a result of another kind than the ticket’s', () =>
    run(
      Effect.gen(function* () {
        const { client, graph, own, worktree } = yield* harness
        yield* graph.update({
          id: own,
          changes: {
            metadata: Schema.decodeSync(TicketMetadata)({
              result_kind: 'migration_added',
            }),
          },
          actor: maintainer,
        })
        const refused = yield* Effect.flip(
          client.finish({
            checkOwn: new CheckOwnPass({ ...head(worktree), output: 'log' }),
            result: summary,
          }),
        )
        expect(refused).toEqual({
          _tag: 'wrong_result_kind',
          expected: 'migration_added',
          given: 'summary',
        })
      }),
    ),
  )

  it.effect(
    'is refused without a pass on HEAD’s tree, or for a commit not HEAD',
    () =>
      run(
        Effect.gen(function* () {
          const { client, worktree } = yield* harness
          const { commit, tree } = head(worktree)
          const notPassed = yield* Effect.flip(
            client.finish({
              checkOwn: new CheckOwnPass({ commit, tree, output: 'log' }),
              result: summary,
            }),
          )
          expect(notPassed).toEqual({ _tag: 'check_own_not_passed', tree })

          const other = CommitHash.make('0'.repeat(40))
          const notHead = yield* Effect.flip(
            client.finish({
              checkOwn: new CheckOwnPass({
                commit: other,
                tree,
                output: 'log',
              }),
              result: summary,
            }),
          )
          expect(notHead._tag).toBe('invalid')
        }),
      ),
  )

  it.effect(
    'records the result on a clean worktree whose tree passed, and ends the turn',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own, worktree, nextOutcome } = yield* harness
          const { commit, tree } = head(worktree)
          yield* (yield* CheckOwnPasses).record({ ticket: own, tree })
          const checkOwn = new CheckOwnPass({ commit, tree, output: 'log' })
          expect(yield* client.finish({ checkOwn, result: summary })).toEqual(
            {},
          )
          const { ticket } = yield* graph.show(own)
          expect(ticket.result).toEqual(Option.some(summary))
          expect(yield* nextOutcome).toEqual(
            Outcome.Finished({ result: summary, checkOwn }),
          )
        }),
      ),
  )

  it.effect('reads HEAD’s tree through git', () =>
    run(
      Effect.gen(function* () {
        const { worktree } = yield* harness
        const gitService = yield* Git
        expect(
          yield* gitService.treeHash({ repo: worktree, revision: 'HEAD' }),
        ).toEqual(Option.some(head(worktree).tree))
        expect(
          yield* gitService.treeHash({ repo: worktree, revision: 'nowhere' }),
        ).toEqual(Option.none())
      }),
    ),
  )
})

describe('defer and wait_for', () => {
  it.effect('defers the ticket with its reason as a note', () =>
    run(
      Effect.gen(function* () {
        const { client, graph, own, nextOutcome } = yield* harness
        yield* client.defer({ reason: 'The spike must settle Pi first.' })
        const detail = yield* graph.show(own)
        expect(detail.ticket.status).toBe('deferred')
        expect(detail.notes.map(note => note.body)).toEqual([
          'The spike must settle Pi first.',
        ])
        expect(yield* nextOutcome).toEqual(
          Outcome.Deferred({ reason: 'The spike must settle Pi first.' }),
        )
      }),
    ),
  )

  it.effect(
    'links the ticket as blocked by the one it waits for, refused while changes are uncommitted',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, own, worktree, nextOutcome } = yield* harness
          const blocker = yield* graph.create({
            ticket: { type: 'task', title: 'The Git service' },
            actor: maintainer,
          })
          writeFileSync(join(worktree, 'README.md'), 'changed\n')
          const refused = yield* Effect.flip(
            client.wait_for({ ticket: blocker.id, needs: 'Git.status' }),
          )
          expect(refused).toEqual({
            _tag: 'worktree_dirty',
            uncommitted: ['README.md'],
            untracked: [],
          })

          git(worktree, 'checkout', '--', 'README.md')
          // An untracked file alone doesn't hold it: nothing is uncommitted.
          writeFileSync(join(worktree, 'notes.txt'), 'scratch\n')
          yield* client.wait_for({ ticket: blocker.id, needs: 'Git.status' })
          const detail = yield* graph.show(own)
          expect(detail.edges).toContainEqual(
            new Edge({ from: blocker.id, to: own, kind: 'blocks' }),
          )
          expect(detail.notes.map(note => note.body)).toEqual([
            `Waiting on ${blocker.id} to merge: Git.status`,
          ])
          expect(yield* nextOutcome).toEqual(
            Outcome.WaitsFor({ ticket: blocker.id, needs: 'Git.status' }),
          )
        }),
      ),
  )

  it.effect('refuses to wait for a ticket that is not there, or itself', () =>
    run(
      Effect.gen(function* () {
        const { client, own } = yield* harness
        const missing = yield* Effect.flip(
          client.wait_for({
            ticket: TicketId.make('fa-nowhere'),
            needs: 'Its API',
          }),
        )
        expect(missing._tag).toBe('invalid')
        const itself = yield* Effect.flip(
          client.wait_for({ ticket: own, needs: 'Itself' }),
        )
        expect(itself._tag).toBe('invalid')
      }),
    ),
  )
})

/** The ID of the next question filed, once it is. */
const questionFiled = (graph: WorkGraph['Service']) =>
  Effect.gen(function* () {
    const changes = yield* graph.changes
    return Effect.flatMap(
      Stream.runHead(
        changes.pipe(
          Stream.filter(event => event.change._tag === 'created'),
          Stream.map(event => event.ticketId),
        ),
      ),
      found => Effect.fromOption(Option.flatten(found)),
    )
  })

describe('ask_and_wait', () => {
  it.effect('hands back the answer given in time', () =>
    run(
      Effect.gen(function* () {
        const { client, graph } = yield* harness
        const filed = yield* questionFiled(graph)
        const waiting = yield* Effect.forkChild(client.ask_and_wait(asking))
        const question = yield* filed
        yield* graph.answer({
          id: question,
          answer: 'Keep it',
          actor: maintainer,
        })
        expect(yield* Fiber.join(waiting)).toEqual({
          _tag: 'answered',
          question,
          answer: 'Keep it',
        })
      }),
    ),
  )

  it.effect(
    'ends the turn unanswered once question_wait runs out, under TestClock',
    () =>
      run(
        Effect.gen(function* () {
          const { client, graph, nextOutcome } = yield* harness
          const filed = yield* questionFiled(graph)
          const waiting = yield* Effect.forkChild(client.ask_and_wait(asking))
          const question = yield* filed
          yield* TestClock.adjust(Duration.minutes(14))
          expect(waiting.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(Duration.minutes(1))
          expect(yield* Fiber.join(waiting)).toEqual({
            _tag: 'unanswered',
            question,
          })
          expect(yield* nextOutcome).toEqual(Outcome.Asked({ question }))
        }),
      ),
  )
})

describe('request_permission and report_unfinished', () => {
  it.effect(
    'forwards a permission request to the attention port, the session named',
    () =>
      run(
        Effect.gen(function* () {
          const { client, own } = yield* harness
          const decision = yield* client.request_permission({
            toolCall: ToolCallId.make('call-1'),
            tool: 'bash',
            input: { command: 'curl https://example.com' },
            shown: PermissionShown.cases.command.make({
              lines: ['curl https://example.com'],
            }),
            why: 'A network-reaching command not on the list',
          })
          expect(decision).toEqual({ _tag: 'allow_run' })
          const asked = yield* Queue.take(yield* AskedPermissions)
          expect(asked).toMatchObject({
            project,
            ticket: own,
            session,
            toolCall: 'call-1',
            tool: 'bash',
          })
        }),
      ),
  )

  it.effect('publishes a session settled with no outcome as unfinished', () =>
    run(
      Effect.gen(function* () {
        const { client, nextOutcome } = yield* harness
        yield* client.report_unfinished({})
        expect(yield* nextOutcome).toEqual(Outcome.Unfinished())
      }),
    ),
  )
})
