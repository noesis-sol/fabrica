import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  ControlRpcs,
  EngineHost,
  FabricaRpcs,
  ModelName,
  ProjectId,
  ProjectNotFound,
  type ProjectSettings,
  ProjectSource,
  ProviderName,
  type TalkContext,
  TalkId,
  TalkToolsGiven,
  TicketId,
  type Tool,
  ToolCallId,
  ToolRefusal,
  controlTokenClient,
  decodeProjectSettings,
} from '@fabrica/contracts'

import {
  AgentOwner,
  PiAgent,
  type PiAgentConfig,
  layer as agentLayer,
} from '../src/agent'
import { pathsIn, startEngine } from '../src/engine'
import {
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import type { ProjectRecord } from '../src/projects'
import { Projects } from '../src/projects/service'
import { type Caller, ModelProxy } from '../src/proxy'
import { type RunHosting, refusingRuns } from '../src/run/hosting'
import {
  type TalkAgentStart,
  TalkAgents,
  TalkModes,
  type TalkModesShape,
  Talks,
  hostedTalkAgents,
  piTalkAgents,
  registeredModes,
  talkAgentTools,
  talkTool,
  layer as talksLayer,
} from '../src/talks'
import { PI_STUB } from './pi-stub'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// Talks' agents on the live `PiAgent` (spec §15.4, §12.9), over the scripted Pi at the boundary: Pi starts
// in the project's checkout, read-only, on the talk's session folder, the kept session's file and the
// mode's instructions, its providers pointed at the model proxy under an agent token of its own; the
// mode's tools reach the engine over a control channel of the talk's own, which reaches nothing else.
// Then the Talks service on them, as the daemon runs it, and the agents on the run hosting.

let root = ''
let stub = ''
let checkout = ''
let extension = ''

beforeAll(() => {
  // Short, for the control sockets' paths, and real, as the stub's working folder reads it.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ta-')))
  stub = join(root, 'pi-stub.mjs')
  writeFileSync(stub, PI_STUB)
  checkout = join(root, 'checkout')
  mkdirSync(checkout)
  extension = join(root, 'extension.js')
  writeFileSync(extension, 'export default function () {}\n')
})

/** One line of the stub's log. */
interface Entry {
  readonly event: string
  readonly type?: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: ReadonlyArray<string>
  readonly models?: unknown
  readonly command?: { readonly sessionPath?: string }
  readonly control?: {
    readonly role?: string
    readonly talkTools?: string
    readonly socket?: string
    readonly token?: string
  }
}

/** What the stub has logged so far: it logs its start and each command before answering it. */
const entries = (log: string): ReadonlyArray<Entry> =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map((line): Entry => JSON.parse(line))

const startedEntry = (log: string): Entry => {
  const found = entries(log).find(({ event }) => event === 'start')
  if (found === undefined) throw new Error('the stub never started')
  return found
}

let counter = 0

/** A test's own folders, and a CLI that runs the stub in `mode`, as a talk's environment can't say so. */
const folders = (mode: string) => {
  counter += 1
  const base = join(root, `${counter}`)
  mkdirSync(base)
  const log = join(base, 'log')
  writeFileSync(log, '')
  const cli = join(base, 'pi.mjs')
  writeFileSync(
    cli,
    `process.env.STUB_LOG = ${JSON.stringify(log)}
process.env.STUB_MODE = ${JSON.stringify(mode)}
await import(${JSON.stringify(stub)})
`,
  )
  return {
    log,
    cli,
    data: join(base, 'data'),
    sockets: join(base, 's'),
    sessions: join(base, 'talks', 'sessions'),
    configRoot: join(base, 'agents'),
  }
}

const agentConfig = (places: ReturnType<typeof folders>): PiAgentConfig => ({
  node: process.execPath,
  cli: places.cli,
  extension,
  data: places.data,
  configRoot: places.configRoot,
  limits: {
    handshake: Duration.seconds(10),
    answer: Duration.seconds(10),
    abort: Duration.seconds(5),
    reap: Duration.seconds(5),
  },
  reaperPoll: Duration.millis(200),
  reaperGrace: Duration.millis(500),
})

const runner = () =>
  runnerLayer({
    hostEnvironment: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      LANG: 'C',
      ANTHROPIC_API_KEY: 'never passed',
    },
    enginePriority: 0,
    priority: hostPriority,
    listProcesses,
    pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
    self: process.pid,
    killGrace: Duration.millis(500),
    outputGrace: Duration.millis(200),
  })

/** A proxy that grants one token to each caller, keeping who holds one for as long as its scope is open. */
const recordingProxy = (held: Ref.Ref<ReadonlyArray<Caller>>) =>
  Layer.succeed(ModelProxy)(
    ModelProxy.of({
      address: 'http://127.0.0.1:9',
      grant: caller =>
        Effect.acquireRelease(
          Effect.as(
            Ref.update(held, all => [...all, caller]),
            {
              token: Redacted.make('agent-token-1'),
              baseUrls: {
                [ProviderName.make('anthropic')]:
                  'http://127.0.0.1:9/anthropic',
              },
              providers: [
                {
                  provider: 'anthropic',
                  baseUrl: 'http://127.0.0.1:9/anthropic',
                },
              ],
            },
          ),
          () => Ref.update(held, all => all.filter(other => other !== caller)),
        ),
      listenOn: () => Effect.die('unused'),
      events: Effect.die('unused'),
      windows: Effect.succeed([]),
      probe: () => Effect.die('unused'),
      refresh: () => Effect.die('unused'),
    }),
  )

/** The agents' services on the stub in `mode`, with the proxy's holders and the folders. */
const onStub = Effect.fn(function* (mode: string) {
  const places = folders(mode)
  const held = yield* Ref.make<ReadonlyArray<Caller>>([])
  const context = yield* Layer.build(
    piTalkAgents({ sockets: places.sockets }).pipe(
      Layer.provideMerge(agentLayer(agentConfig(places))),
      Layer.provideMerge(recordingProxy(held)),
      Layer.provideMerge(runner()),
      Layer.provide(layerClock),
    ),
  )
  return { places, held, context }
})

const fileTree = 'file_tree'
const fileTreeTool: Tool<
  Schema.Struct<{ readonly title: typeof Schema.String }>,
  Schema.Struct<{ readonly filed: typeof Schema.String }>
> = {
  name: fileTree,
  description: 'Files the tree.',
  parameters: Schema.Struct({ title: Schema.String }),
  success: Schema.Struct({ filed: Schema.String }),
}

const project = ProjectId.make('work')
const talk = TalkId.make('talk-one')
const instructions = 'Talk it through with the maintainer.'

const startOf = (
  sessions: string,
  overrides: Partial<TalkAgentStart> = {},
): TalkAgentStart => ({
  talk,
  mode: 'feature',
  project,
  checkout,
  projectTrusted: false,
  model: {
    provider: 'anthropic',
    model: ModelName.make('claude-x'),
    thinking: Option.none(),
  },
  instructions,
  tools: [fileTreeTool],
  readsCode: true,
  call: ({ tool, input }) =>
    tool === fileTree
      ? Effect.succeed({ filed: JSON.stringify(input) })
      : Effect.fail(ToolRefusal.cases.invalid.make({ issue: `no ${tool}` })),
  sessions,
  resume: Option.none(),
  ...overrides,
})

/** A client of the control group on `socket`, its requests carrying `token`. */
const connect = (socket: string, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(NodeSocket.layerNet({ path: socket })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        controlTokenClient(token),
      ),
    )
    return yield* Effect.provide(RpcClient.make(ControlRpcs), context)
  })

const controlOf = (log: string) => {
  const { control } = startedEntry(log)
  if (control?.socket === undefined || control.token === undefined)
    throw new Error('the stub was given no control channel')
  return { socket: control.socket, token: control.token, control }
}

describe('talks agents on PiAgent', () => {
  it.live(
    "starts Pi in the checkout, read-only, on the talk's session folder and the mode's instructions",
    () =>
      Effect.gen(function* () {
        const { places, held, context } = yield* onStub('normal')
        const { start } = yield* Effect.provide(TalkAgents, context)
        const agent = yield* Effect.provide(
          start(startOf(places.sessions)),
          context,
        )
        expect(
          Option.getOrThrow(agent.session.file).startsWith(places.sessions),
        ).toBe(true)
        const started = startedEntry(places.log)
        expect(started.cwd).toBe(checkout)
        expect(started.args).toEqual([
          '--mode',
          'rpc',
          '--extension',
          extension,
          '--session-dir',
          places.sessions,
          '--no-skills',
          '--provider',
          'anthropic',
          '--model',
          'claude-x',
          '--tools',
          `read,grep,find,ls,${fileTree}`,
          '--append-system-prompt',
          instructions,
        ])
        expect(started.env).not.toContain('ANTHROPIC_API_KEY')
        expect(started.env).toContain('FABRICA_CONTROL_SOCKET')
        // Its providers at the proxy, under the token it was granted.
        expect(started.models).toEqual({
          providers: {
            anthropic: {
              baseUrl: 'http://127.0.0.1:9/anthropic',
              apiKey: 'agent-token-1',
            },
          },
        })
        const [caller] = yield* Ref.get(held)
        expect(caller?.ticket).toEqual(Option.none())
        expect(caller?.model).toBe('anthropic/claude-x')
        const { control } = controlOf(places.log)
        expect(control.role).toBe('talk')
        expect(
          Schema.decodeUnknownSync(TalkToolsGiven)(control.talkTools).map(
            ({ name }) => name,
          ),
        ).toEqual([fileTree])
      }).pipe(Effect.scoped),
  )

  it('never gives Pi its shell or writers, and no readers where the mode reads no code', () => {
    const tools = [fileTreeTool]
    expect(talkAgentTools({ tools, readsCode: true })).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      fileTree,
    ])
    expect(talkAgentTools({ tools, readsCode: false })).toEqual([fileTree])
  })

  it.live('resumes the kept session file', () =>
    Effect.gen(function* () {
      const { places, context } = yield* onStub('normal')
      const kept = join(places.sessions, 'kept.jsonl')
      const { start } = yield* Effect.provide(TalkAgents, context)
      const agent = yield* Effect.provide(
        start(startOf(places.sessions, { resume: Option.some(kept) })),
        context,
      )
      expect(agent.session.file).toEqual(Option.some(kept))
      expect(
        entries(places.log).find(({ type }) => type === 'switch_session')
          ?.command?.sessionPath,
      ).toBe(kept)
    }).pipe(Effect.scoped),
  )

  it.live(
    'sends prompts and steers, its events streamed until the turn settles',
    () =>
      Effect.gen(function* () {
        const { places, context } = yield* onStub('normal')
        const { start } = yield* Effect.provide(TalkAgents, context)
        const agent = yield* Effect.provide(
          start(startOf(places.sessions)),
          context,
        )
        const heard = yield* (yield* agent.events).pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* agent.prompt('Hello.')
        const events = yield* Fiber.join(heard)
        expect(events.map(({ type }) => type)).toContain('agent_settled')
        yield* agent.steer('And another thing.')
        expect(
          entries(places.log).filter(
            ({ type }) => type === 'prompt' || type === 'steer',
          ),
        ).toHaveLength(2)
      }).pipe(Effect.scoped),
  )

  it.live(
    "routes the extension's calls to the mode's tools, by name, and refuses all else",
    () =>
      Effect.gen(function* () {
        const { places, context } = yield* onStub('normal')
        const { start } = yield* Effect.provide(TalkAgents, context)
        yield* Effect.provide(start(startOf(places.sessions)), context)
        const { socket, token } = controlOf(places.log)
        const client = yield* connect(socket, token)
        expect(
          yield* client.talk_tool({ tool: fileTree, input: { title: 'x' } }),
        ).toEqual({ filed: '{"title":"x"}' })
        const refused = yield* Effect.flip(
          client.talk_tool({ tool: 'other', input: {} }),
        )
        expect(refused).toEqual(
          ToolRefusal.cases.invalid.make({ issue: 'no other' }),
        )
        // A worker's tool reaches nothing through a talk's token.
        const worker = yield* Effect.flip(client.add_note({ body: 'a note' }))
        expect(worker).toEqual(
          ToolRefusal.cases.invalid.make({
            issue: "add_note isn't a talk's tool",
          }),
        )
        // Whatever the gate would ask the maintainer about, a talk is refused.
        const decision = yield* client.request_permission({
          toolCall: ToolCallId.make('call-1'),
          tool: 'bash',
          input: {},
          shown: { _tag: 'command', lines: ['ls'] },
          why: 'it asks',
        })
        expect(decision._tag).toBe('refuse')
        expect(yield* client.merge_standing({})).toBe('not_queued')
      }).pipe(Effect.scoped),
  )

  it.live("refuses a request without the talk's token", () =>
    Effect.gen(function* () {
      const { places, context } = yield* onStub('normal')
      const { start } = yield* Effect.provide(TalkAgents, context)
      yield* Effect.provide(start(startOf(places.sessions)), context)
      const { socket } = controlOf(places.log)
      const client = yield* connect(socket, 'not its token')
      const refused = yield* Effect.flip(
        client.talk_tool({ tool: fileTree, input: { title: 'x' } }),
      )
      expect(refused).toMatchObject({ _tag: 'ControlUnauthorized' })
    }).pipe(Effect.scoped),
  )

  it.live(
    "its scope's end closes Pi, the channel and the token, and the talk can start again",
    () =>
      Effect.gen(function* () {
        const { places, held, context } = yield* onStub('normal')
        const { start } = yield* Effect.provide(TalkAgents, context)
        const scope = yield* Scope.make()
        yield* start(startOf(places.sessions)).pipe(
          Scope.provide(scope),
          Effect.provide(context),
        )
        const { socket } = controlOf(places.log)
        expect(existsSync(socket)).toBe(true)
        expect(yield* Ref.get(held)).toHaveLength(1)
        yield* Scope.close(scope, Exit.void)
        expect(existsSync(socket)).toBe(false)
        expect(yield* Ref.get(held)).toHaveLength(0)
        expect(entries(places.log).map(({ event }) => event)).toContain(
          'sigterm',
        )
        yield* Effect.provide(start(startOf(places.sessions)), context)
        expect(existsSync(socket)).toBe(true)
      }).pipe(Effect.scoped),
  )

  it.live('says why Pi refused to start, leaving nothing behind', () =>
    Effect.gen(function* () {
      const { places, held, context } = yield* onStub('exit-at-start')
      const { start } = yield* Effect.provide(TalkAgents, context)
      const failed = yield* Effect.flip(
        Effect.scoped(Effect.provide(start(startOf(places.sessions)), context)),
      )
      expect(failed.talk).toBe(talk)
      expect(failed.reason).toContain('no model configured')
      expect(yield* Ref.get(held)).toHaveLength(0)
    }),
  )

  it.live('keys a talk apart from a ticket of the same name', () =>
    Effect.gen(function* () {
      const { places, context } = yield* onStub('normal')
      const { start } = yield* Effect.provide(TalkAgents, context)
      yield* Effect.provide(start(startOf(places.sessions)), context)
      const agents = yield* Effect.provide(PiAgent, context)
      const ticket = yield* Effect.provide(
        agents.start({
          owner: AgentOwner.Ticket({ ticket: TicketId.make('talk-one') }),
          project,
          worktree: checkout,
          providers: [],
          token: 't',
          model: Option.none(),
          tools: Option.none(),
          resume: Option.none(),
          env: {},
          projectTrusted: false,
          nice: Option.none(),
        }),
        context,
      )
      expect(ticket.session.id.length).toBeGreaterThan(0)
    }).pipe(Effect.scoped),
  )
})

describe('the Talks service on PiAgent', () => {
  const record = (): ProjectRecord => ({
    id: project,
    name: 'Work',
    path: checkout,
    origin: 'registered',
    url: Option.none(),
    base: 'main',
    trusted: true,
  })

  const oneProject = (settings: ProjectSettings) => {
    const unused = Effect.die('not asked of the projects by talks')
    return Layer.succeed(Projects)({
      add: () => unused,
      list: unused,
      remove: () => unused,
      find: id =>
        id === project
          ? Effect.succeed(record())
          : Effect.fail(new ProjectNotFound({ project: id })),
      setTrusted: () => unused,
      setRun: () => unused,
      worktreeHome: () => unused,
      settings: () => Effect.succeed(settings),
      setSettings: () => unused,
      workGraph: () => unused,
      onBase: () => unused,
      watchStatus: () => Stream.die('not asked of the projects by talks'),
    })
  }

  const modes: TalkModesShape = {
    run: {
      keep: true,
      readsCode: false,
      instructions: 'Keep the run.',
      tools: [
        talkTool<
          'run',
          typeof fileTreeTool.parameters,
          typeof fileTreeTool.success
        >(fileTreeTool, ({ title }, { actor }) =>
          Effect.succeed({
            filed: `${title} by ${actor._tag === 'talk' ? actor.session : actor._tag}`,
          }),
        ),
      ],
      opening: () => Effect.succeed(Option.none()),
    },
    feature: {
      keep: false,
      instructions,
      tools: [],
      opening: () => Effect.succeed(Option.some('Open on it.')),
    },
  }

  const runContext: TalkContext = { _tag: 'run' }

  const talksOn = Effect.fn(function* () {
    const { places, context } = yield* onStub('normal')
    const settings = yield* Effect.orDie(
      decodeProjectSettings({ model: 'anthropic/claude-x' }),
    )
    const scope = yield* Scope.Scope
    const services = yield* Layer.build(
      talksLayer({
        data: places.data,
        scope,
        flush: Effect.succeed(Duration.millis(1)),
      }).pipe(
        Layer.provide(oneProject(settings)),
        Layer.provide(Layer.succeed(TalkModes)(modes)),
        Layer.provide(Layer.succeedContext(context)),
      ),
    )
    return { places, talks: yield* Effect.provide(Talks, services) }
  })

  it.live(
    "keeps the run talk's session file and resumes it on the same talk, its tools acting as its session",
    () =>
      Effect.gen(function* () {
        const { places, talks } = yield* talksOn()
        const opened = yield* talks.open({
          project,
          context: runContext,
          model: Option.none(),
        })
        const started = startedEntry(places.log)
        expect(started.cwd).toBe(checkout)
        // The run talk reads the run through its tools alone.
        expect(started.args).toContain(fileTree)
        expect(started.args?.join(' ')).not.toContain('read,')
        const { socket, token } = controlOf(places.log)
        const client = yield* connect(socket, token)
        expect(
          yield* client.talk_tool({ tool: fileTree, input: { title: 'x' } }),
        ).toEqual({ filed: `x by ${opened.session}` })
        // Refused by the mode: the engine decodes the arguments.
        const invalid = yield* Effect.flip(
          client.talk_tool({ tool: fileTree, input: { nope: 1 } }),
        )
        expect(invalid).toMatchObject({ _tag: 'invalid' })
        const kept = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({ talk: TalkId, session: Schema.String }),
          ),
        )(
          readFileSync(
            join(places.data, 'projects', project, 'talks', 'run.json'),
            'utf8',
          ),
        )
        expect(kept.talk).toBe(opened.talk)
        yield* talks.close(opened.talk)
        const again = yield* talks.open({
          project,
          context: runContext,
          model: Option.none(),
        })
        expect(again.talk).toBe(opened.talk)
        expect(
          entries(places.log).find(({ type }) => type === 'switch_session')
            ?.command?.sessionPath,
        ).toBe(kept.session)
      }).pipe(Effect.scoped),
  )

  it.live(
    "a new talk's opening is sent as its first prompt, in its own session folder",
    () =>
      Effect.gen(function* () {
        const { places, talks } = yield* talksOn()
        const opened = yield* talks.open({
          project,
          context: { _tag: 'feature', text: Option.some('Dark mode') },
          model: Option.none(),
        })
        const started = startedEntry(places.log)
        expect(started.args).toContain(
          join(places.data, 'projects', project, 'talks', opened.talk),
        )
        expect(started.args).toContain(instructions)
        const prompted = yield* Effect.callback<void>(resume => {
          const timer = setInterval(() => {
            if (entries(places.log).some(({ type }) => type === 'prompt')) {
              clearInterval(timer)
              resume(Effect.void)
            }
          }, 20)
          return Effect.sync(() => clearInterval(timer))
        }).pipe(Effect.as(true))
        expect(prompted).toBe(true)
        yield* talks.close(opened.talk)
      }).pipe(Effect.scoped),
  )
})

/** The Talks group of a daemon on `runs`, its talks' agents on them, with a project set to a model. */
const daemonOn = Effect.fn(function* (
  places: ScriptedPlaces,
  runs: (data: string) => Layer.Layer<RunHosting>,
) {
  const data = yield* Effect.promise(() => mkdtemp(join(places.root, 'e')))
  const paths = pathsIn({ data, socketFolder: data })
  yield* startEngine({
    paths,
    host: new EngineHost({
      platform: 'linux',
      arch: 'x64',
      hostname: 'test-host',
      cores: 4,
    }),
    release: '1.2.3',
    git: engineGit(places),
    runs: runs(paths.data),
    talks: Layer.merge(registeredModes, hostedTalkAgents),
  })
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([
        NodeSocket.layerNet({ path: paths.socket }),
        RpcSerialization.layerNdjson,
      ]),
    ),
  )
  const client = yield* RpcClient.make(FabricaRpcs).pipe(
    Effect.provide(protocol),
  )
  const { id } = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({
      path: makeCheckout(places, {
        ...scriptedSettings,
        model: 'anthropic/claude-opus-5-5',
      }),
    }),
    name: Option.some('work'),
  })
  return { client, id }
})

describe('the daemon, its talks on its run hosting', () => {
  it.live("opens the project's run talk on a Pi through its model proxy", () =>
    Effect.gen(function* () {
      const places = makeScriptedPlaces()
      const { client, id } = yield* daemonOn(places, data =>
        scriptedHosting(places, data),
      )
      const opened = yield* client['talk.open']({
        project: id,
        context: { _tag: 'run' },
        model: Option.none(),
      })
      expect(opened.session).toMatch(/^s-[0-9]+$/u)
      expect(opened.model).toBe('anthropic/claude-opus-5-5')
      yield* client['talk.close']({ talk: opened.talk })
    }).pipe(Effect.scoped),
  )

  it.live("refuses a talk, saying why, where it can't run a project", () =>
    Effect.gen(function* () {
      const places = makeScriptedPlaces()
      const { client, id } = yield* daemonOn(places, () =>
        refusingRuns('its agents are missing'),
      )
      const refused = yield* Effect.flip(
        client['talk.open']({
          project: id,
          context: { _tag: 'run' },
          model: Option.none(),
        }),
      )
      expect(refused).toMatchObject({
        _tag: 'TalkNotOpened',
        reason: expect.stringContaining('its agents are missing'),
      })
    }).pipe(Effect.scoped),
  )
})

describe('talks agents on the run hosting', () => {
  it.live(
    "are refused, for the hosting's reason, where the engine can't run a project",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(
          hostedTalkAgents.pipe(Layer.provide(refusingRuns('no agents here'))),
        )
        const { start } = yield* Effect.provide(TalkAgents, services)
        const failed = yield* Effect.flip(
          Effect.scoped(start(startOf(join(root, 'never')))),
        )
        expect(failed.reason).toContain('no agents here')
      }).pipe(Effect.scoped),
  )

  it.live("start on the hosting's agents and model proxy where it can", () =>
    Effect.gen(function* () {
      const places = makeScriptedPlaces()
      const hosting = scriptedHosting(places, join(places.root, 'data'))
      const services = yield* Layer.build(
        hostedTalkAgents.pipe(Layer.provide(hosting)),
      )
      const { start } = yield* Effect.provide(TalkAgents, services)
      const sessions = join(places.root, 'talks', 'sessions')
      const agent = yield* start(startOf(sessions))
      expect(Option.getOrThrow(agent.session.file).startsWith(sessions)).toBe(
        true,
      )
    }).pipe(Effect.scoped),
  )
})
