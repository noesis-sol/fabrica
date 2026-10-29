import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from 'effect'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Edge,
  ProjectId,
  ProjectNotFound,
  SessionId,
  type TalkContext,
  TalkNotOpened,
  TicketId,
  ToolRefusal,
  TreeItem,
  decodeProjectSettings,
} from '@fabrica/contracts'

import type { PiEvent } from '../src/agent'
import { type ProjectRecord, Projects } from '../src/projects'
import {
  type TalkAgentStart,
  TalkAgents,
  Talks,
  type TalksShape,
  registeredModes,
  layer as talksLayer,
} from '../src/talks'
import { featureInstructions } from '../src/talks/feature'
import { refineInstructions } from '../src/talks/refine'
import {
  WorkGraph,
  type WorkGraphShape,
  makeWorkGraph,
  storeLayer,
  treeProblems,
} from '../src/workgraph'

// The refine and feature talks (spec §15.4, §15.5), the modes the engine registers, on a scripted Pi
// session in place of a talk's agent and an in-memory work graph. The script answers each prompt by
// calling the talk's `file_tree` with the tree the test gives it, through the engine's side of the
// call, as a talk's agent hands a call over: a feature talk files an epic with its tickets, a refine
// talk files a spec's tree with the spec on each ticket, and a tree that fails its check is refused
// with every reason at once, with nothing filed.

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-refine-')))
})

const project = ProjectId.make('work')

/** What the scripted agents were started with and asked, and the answers of their calls. */
interface Script {
  readonly started: Ref.Ref<ReadonlyArray<TalkAgentStart>>
  readonly prompts: Ref.Ref<ReadonlyArray<string>>
  /** The calls each prompt makes, in turn: a tool and its arguments. */
  readonly calls: Queue.Queue<{
    readonly tool: string
    readonly input: unknown
  }>
  /** Each call's answer, or why it was refused. */
  readonly answers: Queue.Queue<Exit.Exit<unknown, ToolRefusal>>
}

/** Talks' agents whose every prompt makes the next scripted call, if there is one, then settles. */
const scriptedAgents = (script: Script) =>
  Layer.succeed(TalkAgents)({
    start: options =>
      Effect.gen(function* () {
        yield* Ref.update(script.started, all => [...all, options])
        const events = yield* PubSub.unbounded<PiEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(events))
        return {
          session: {
            id: SessionId.make(`s-${options.talk}`),
            file: Option.none(),
          },
          events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          prompt: message =>
            Effect.gen(function* () {
              yield* Ref.update(script.prompts, all => [...all, message])
              const next = yield* Queue.poll(script.calls)
              if (Option.isSome(next))
                yield* Queue.offer(
                  script.answers,
                  yield* Effect.exit(options.call(next.value)),
                )
              yield* PubSub.publish(events, {
                type: 'agent_settled',
                aborted: false,
              })
            }),
          steer: () => Effect.void,
        }
      }),
  })

/** Projects with one, `work`, at `checkout`, its work graph `graph`; nothing else is asked of them. */
const oneProject = (checkout: string, graph: WorkGraphShape) =>
  Effect.gen(function* () {
    const settings = yield* Effect.orDie(
      decodeProjectSettings({ model: 'anthropic/claude-opus-5-5' }),
    )
    const record: ProjectRecord = {
      id: project,
      name: 'Work',
      path: checkout,
      origin: 'registered',
      url: Option.none(),
      base: 'main',
      trusted: true,
    }
    const unused = Effect.die('not asked of the projects by talks')
    const ours = <A>(id: ProjectId, value: A) =>
      id === project
        ? Effect.succeed(value)
        : Effect.fail(new ProjectNotFound({ project: id }))
    return Layer.succeed(Projects)({
      add: () => unused,
      list: unused,
      remove: () => unused,
      find: id => ours(id, record),
      setTrusted: () => unused,
      worktreeHome: () => unused,
      settings: id => ours(id, settings),
      setSettings: () => unused,
      workGraph: id => ours(id, graph),
      onBase: () => unused,
      watchStatus: () => Stream.die('not asked of the projects by talks'),
    })
  })

/** An engine's talks, with the registered modes, on a new work graph and a checkout holding `spec`. */
const newEngine = Effect.gen(function* () {
  const checkout = mkdtempSync(NodePath.join(root, 'checkout-'))
  mkdirSync(NodePath.join(checkout, 'docs'))
  writeFileSync(NodePath.join(checkout, 'docs', 'spec.md'), '# Notes\n')
  const graph = Context.get(
    yield* Layer.build(
      Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
        Layer.provide(storeLayer(':memory:')),
      ),
    ),
    WorkGraph,
  )
  const script: Script = {
    started: yield* Ref.make<ReadonlyArray<TalkAgentStart>>([]),
    prompts: yield* Ref.make<ReadonlyArray<string>>([]),
    calls: yield* Queue.unbounded<{
      readonly tool: string
      readonly input: unknown
    }>(),
    answers: yield* Queue.unbounded<Exit.Exit<unknown, ToolRefusal>>(),
  }
  const talks: TalksShape = Context.get(
    yield* Layer.build(
      talksLayer({
        data: mkdtempSync(NodePath.join(root, 'data-')),
        scope: yield* Scope.Scope,
        flush: Effect.succeed(Duration.millis(0)),
      }).pipe(
        Layer.provide([
          yield* oneProject(checkout, graph),
          scriptedAgents(script),
          registeredModes,
        ]),
      ),
    ),
    Talks,
  )
  return { graph, script, talks, checkout }
})

/** Opens a talk in `context`, its first prompt calling `file_tree` with `items`, and gives the call's answer. */
const fileThrough = (
  engine: Effect.Success<typeof newEngine>,
  context: TalkContext,
  items: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    yield* Queue.offer(engine.script.calls, {
      tool: 'file_tree',
      input: { items },
    })
    const opened = yield* engine.talks.open({
      project,
      context,
      model: Option.none(),
    })
    return { opened, answer: yield* Queue.take(engine.script.answers) }
  })

/** A ticket of the tree, as a talk's model writes it. */
const item = (fields: {
  readonly key: string
  readonly type?: TreeItem['type']
  readonly title: string
  readonly parent?: string
  readonly waitsOn?: ReadonlyArray<string>
  /** For a ticket, `unknown` when left out; `null` leaves them out. */
  readonly files?: ReadonlyArray<string> | 'unknown' | null
  readonly [more: string]: unknown
}) => {
  const { files, ...rest } = fields
  const given =
    files === undefined && fields.type !== 'epic' ? 'unknown' : files
  return {
    type: 'task',
    description: `Details of ${fields.key}.`,
    ...(given === undefined || given === null ? {} : { files: given }),
    ...rest,
  }
}

/** What the call answered, where it was answered. */
const answerOf = (exit: Exit.Exit<unknown, ToolRefusal>): unknown =>
  Exit.isSuccess(exit) ? exit.value : expect.fail(Cause.pretty(exit.cause))

/** Why the call was refused, where it was. */
const refusalOf = (exit: Exit.Exit<unknown, ToolRefusal>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it was answered')

/** The edges of the graph, as `<from> <kind> <to>`. */
const edgesOf = (graph: WorkGraphShape) =>
  Effect.map(graph.edges(), edges =>
    edges.map(({ from, to, kind }: Edge) => `${from} ${kind} ${to}`).sort(),
  )

describe('the feature talk', () => {
  it.effect(
    'opens on the feature’s text, with file_tree, and files an epic with its tickets',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { opened, answer } = yield* fileThrough(
          engine,
          { _tag: 'feature', text: Option.some('Dark mode') },
          [
            item({ key: 'dark', type: 'epic', title: 'Dark mode' }),
            item({
              key: 'tokens',
              title: 'Dark theme tokens',
              parent: 'dark',
              files: ['packages/ui/src/theme.ts'],
              priority: 1,
              design: 'The maintainer chose a warm grey, not black.',
            }),
            item({
              key: 'toggle',
              title: 'A toggle in the settings',
              parent: 'dark',
              waitsOn: ['tokens'],
              acceptance: 'The toggle switches the theme at once.',
            }),
          ],
        )

        const [started] = yield* Ref.get(engine.script.started)
        expect(started?.mode).toBe('feature')
        expect(started?.instructions).toBe(featureInstructions)
        expect(started?.tools.map(tool => tool.name)).toStrictEqual([
          'file_tree',
        ])
        expect(yield* Ref.get(engine.script.prompts)).toStrictEqual([
          'Talk this feature through with me, then file it: Dark mode',
        ])

        // The answer is the filed tree, encoded as the agent gets it.
        const filed = answerOf(answer)
        const tickets = yield* engine.graph.list({})
        const epic = tickets.find(ticket => ticket.type === 'epic')
        if (epic === undefined) return expect.fail('no epic was filed')
        const tokens = TicketId.make(`${epic.id}.1`)
        const toggle = TicketId.make(`${epic.id}.2`)
        expect(filed).toStrictEqual({
          root: epic.id,
          items: [
            { key: 'dark', id: epic.id },
            { key: 'tokens', id: tokens },
            { key: 'toggle', id: toggle },
          ],
        })
        expect(epic.title).toBe('Dark mode')
        const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
        expect(byId.get(tokens)).toMatchObject({
          type: 'task',
          title: 'Dark theme tokens',
          priority: 1,
          design: Option.some('The maintainer chose a warm grey, not black.'),
        })
        expect(byId.get(tokens)?.metadata.files).toStrictEqual(
          Option.some(['packages/ui/src/theme.ts']),
        )
        expect(byId.get(toggle)).toMatchObject({
          acceptance: Option.some('The toggle switches the theme at once.'),
          priority: 2,
        })
        expect(byId.get(toggle)?.metadata.files).toStrictEqual(Option.none())
        expect(epic.metadata.spec).toStrictEqual(Option.none())
        expect(yield* edgesOf(engine.graph)).toStrictEqual(
          [
            `${epic.id} parent ${tokens}`,
            `${epic.id} parent ${toggle}`,
            `${tokens} blocks ${toggle}`,
          ].sort(),
        )

        // Filed by the talk's session.
        const history = yield* engine.graph.history(epic.id)
        expect(history[0]?.actor).toStrictEqual(
          Option.some({ _tag: 'talk', session: opened.session }),
        )
      }).pipe(Effect.scoped),
  )

  it.effect('waits for the maintainer when opened without a text', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      yield* engine.talks.open({
        project,
        context: { _tag: 'feature', text: Option.none() },
        model: Option.none(),
      })
      expect(yield* Ref.get(engine.script.prompts)).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})

describe('the refine talk', () => {
  it.effect(
    'opens on the spec, and files its tree with the spec on every ticket',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { answer } = yield* fileThrough(
          engine,
          { _tag: 'refine', spec: 'docs/spec.md' },
          [
            item({ key: 'notes', type: 'epic', title: 'Notes app' }),
            item({
              key: 'env',
              title: 'Set up the toolchain and checks',
              parent: 'notes',
              labels: ['solo'],
              priority: 0,
              files: ['package.json', 'mise.toml'],
            }),
            item({
              key: 'store',
              type: 'epic',
              title: 'Storage',
              parent: 'notes',
            }),
            item({
              key: 'schema',
              title: 'The notes table',
              parent: 'store',
              waitsOn: ['env'],
              files: ['src/store/schema.ts'],
            }),
            item({
              key: 'search',
              title: 'Full-text search',
              parent: 'store',
              waitsOn: ['env', 'schema'],
            }),
          ],
        )

        const [started] = yield* Ref.get(engine.script.started)
        expect(started?.mode).toBe('refine')
        expect(started?.instructions).toBe(refineInstructions)
        expect(started?.tools.map(tool => tool.name)).toStrictEqual([
          'file_tree',
        ])
        expect(yield* Ref.get(engine.script.prompts)).toStrictEqual([
          'Refine the spec docs/spec.md with me before its breakdown, then file its tree.',
        ])

        const filed = answerOf(answer)
        const tickets = yield* engine.graph.list({})
        const notes = tickets.find(ticket => ticket.title === 'Notes app')
        if (notes === undefined) return expect.fail('no root was filed')
        // Parents first: the root's children, then theirs.
        const env = TicketId.make(`${notes.id}.1`)
        const store = TicketId.make(`${notes.id}.2`)
        const schema = TicketId.make(`${notes.id}.2.1`)
        const search = TicketId.make(`${notes.id}.2.2`)
        expect(filed).toStrictEqual({
          root: notes.id,
          items: [
            { key: 'notes', id: notes.id },
            { key: 'env', id: env },
            { key: 'store', id: store },
            { key: 'schema', id: schema },
            { key: 'search', id: search },
          ],
        })
        expect(tickets).toHaveLength(5)
        for (const ticket of tickets)
          expect(ticket.metadata.spec).toStrictEqual(
            Option.some('docs/spec.md'),
          )
        const environment = yield* engine.graph.show(env)
        expect(environment.labels).toStrictEqual(['solo'])
        expect(environment.ticket.priority).toBe(0)
        expect(yield* edgesOf(engine.graph)).toStrictEqual(
          [
            `${notes.id} parent ${env}`,
            `${notes.id} parent ${store}`,
            `${store} parent ${schema}`,
            `${store} parent ${search}`,
            `${env} blocks ${schema}`,
            `${env} blocks ${search}`,
            `${schema} blocks ${search}`,
          ].sort(),
        )
      }).pipe(Effect.scoped),
  )

  it.effect('isn’t opened on a spec that isn’t in the checkout', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const open = (spec: string) =>
        Effect.exit(
          engine.talks.open({
            project,
            context: { _tag: 'refine', spec },
            model: Option.none(),
          }),
        ).pipe(
          Effect.map(exit =>
            Exit.isFailure(exit)
              ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
              : expect.fail('it was opened'),
          ),
        )
      expect(yield* open('docs/gone.md')).toStrictEqual(
        new TalkNotOpened({
          reason: "the spec docs/gone.md isn't in the project's checkout",
        }),
      )
      expect(yield* open('../elsewhere.md')).toStrictEqual(
        new TalkNotOpened({
          reason: "the spec ../elsewhere.md isn't a path in the project",
        }),
      )
      expect(yield* Ref.get(engine.script.started)).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect(
    'refuses a tree that fails its check, with every reason at once, and files nothing',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { answer } = yield* fileThrough(
          engine,
          { _tag: 'refine', spec: 'docs/spec.md' },
          [
            item({ key: 'notes', type: 'epic', title: 'Notes app' }),
            item({ key: 'loose', title: 'A loose ticket' }),
            item({
              key: 'schema',
              title: 'The notes table',
              parent: 'notes',
              waitsOn: ['notes'],
            }),
            item({ key: 'schema', title: 'The notes index', parent: 'gone' }),
          ],
        )
        expect(refusalOf(answer)).toStrictEqual(
          ToolRefusal.cases.invalid.make({
            issue:
              'the tree was refused: the key schema is given to 2 items; ' +
              '2 items have no parent (notes, loose): one epic, the root, holds the rest; ' +
              'the root loose is a task: the root is an epic; ' +
              "schema's parent gone isn't in the tree; " +
              'notes, schema wait on one another, through their parents and the items they wait on: notes → schema → notes',
          }),
        )
        expect(yield* engine.graph.list({})).toStrictEqual([])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'refuses a tool the talk hasn’t, and arguments that don’t decode',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        yield* Queue.offer(engine.script.calls, {
          tool: 'close_ticket',
          input: {},
        })
        yield* engine.talks.open({
          project,
          context: { _tag: 'refine', spec: 'docs/spec.md' },
          model: Option.none(),
        })
        expect(
          refusalOf(yield* Queue.take(engine.script.answers)),
        ).toStrictEqual(
          ToolRefusal.cases.invalid.make({
            issue: 'the refine talk has no tool close_ticket',
          }),
        )

        const { answer } = yield* fileThrough(
          engine,
          { _tag: 'feature', text: Option.some('Dark mode') },
          [{ key: 'Dark Mode', type: 'epic', title: 'Dark mode' }],
        )
        expect(refusalOf(answer)).toMatchObject({ _tag: 'invalid' })
        expect(yield* engine.graph.list({})).toStrictEqual([])
      }).pipe(Effect.scoped),
  )
})

describe('the tree’s check', () => {
  const decoded = Schema.decodeUnknownSync(Schema.Array(TreeItem))

  it('passes a tree with one root epic, its parents epics and its waits in it', () => {
    expect(
      treeProblems(
        decoded([
          item({ key: 'a', type: 'epic', title: 'A' }),
          item({ key: 'b', title: 'B', parent: 'a' }),
          item({ key: 'c', title: 'C', parent: 'a', waitsOn: ['b'] }),
        ]),
      ),
    ).toStrictEqual([])
  })

  it('names every problem: parents, waits, files and cycles', () => {
    expect(
      treeProblems(
        decoded([
          item({ key: 'a', type: 'epic', title: 'A', files: ['x.ts'] }),
          item({ key: 'b', title: 'B', parent: 'a', waitsOn: ['b', 'zz'] }),
          item({ key: 'c', title: 'C', parent: 'b', files: null }),
          item({ key: 'd', title: 'D', parent: 'a', waitsOn: ['e'] }),
          item({ key: 'e', title: 'E', parent: 'a', waitsOn: ['d'] }),
          item({ key: 'f', type: 'epic', title: 'F', parent: 'f' }),
        ]),
      ),
    ).toStrictEqual([
      'the epic a names files: an epic changes none, its tickets do',
      'b waits on itself',
      "b waits on zz, which isn't in the tree",
      "c's parent b is a task: only an epic holds others",
      'c names no files: give the files it will change, or "unknown"',
      'f names itself as its parent',
      'd, e wait on one another, through their parents and the items they wait on: d → e → d',
    ])
  })
})
