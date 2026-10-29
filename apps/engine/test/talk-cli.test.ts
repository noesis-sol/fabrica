import {
  Console,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Ref,
  Stdio,
  Stream,
} from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { EngineHost, SessionId } from '@fabrica/contracts'
import { Agent, Daemon, Talks } from '@fabrica/engine'
import {
  Toolbox,
  layerHost,
  layerToolbox,
  makeGitRepo,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { gitOf, onlyJson } from './tickets-engine'

// `fabrica talk` (spec §19, §15.4): run as the CLI's entry runs it, against an engine started in a
// temporary data folder with one project, `work`, whose talks' agent is a scripted Pi session. The
// maintainer's lines come on stdin; the talk's transcript streams on the terminal, and the talk is
// closed once stdin ends and the last message is answered.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** The scripted model's answer to a message: two lines of text, then a tool call that fails. */
const reply = (message: string): ReadonlyArray<Agent.PiEvent> => [
  { type: 'message_start', message: { role: 'assistant' } },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'On it:\nAdding ' },
  },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: `${message}.` },
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'get_ticket',
    args: { id: 'fa-a1b2' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'get_ticket',
    isError: true,
  },
  { type: 'agent_settled', aborted: false },
]

/**
 * Talks whose agents play the script, counting those closed and saying when one is gone; the feature
 * talk waits for the maintainer, the refine talk opens on its spec, no other is served. The prompt
 * "bye" ends the agent, as Pi exiting by itself does.
 */
const scriptedTalks = (options: {
  readonly closed: Ref.Ref<number>
  readonly gone: Deferred.Deferred<void>
}) =>
  Layer.merge(
    Layer.succeed(Talks.TalkModes)({
      feature: {
        keep: false,
        instructions: 'Talk the feature through.',
        tools: [],
        opening: () => Effect.succeedNone,
      },
      refine: {
        keep: false,
        instructions: 'Refine the spec.',
        tools: [],
        opening: ({ context }) => Effect.succeedSome(`Refine ${context.spec}`),
      },
    }),
    Layer.succeed(Talks.TalkAgents)({
      start: () =>
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<Agent.PiEvent>()
          yield* Effect.addFinalizer(() =>
            Effect.andThen(
              PubSub.shutdown(events),
              Effect.andThen(
                Ref.update(options.closed, n => n + 1),
                Deferred.succeed(options.gone, undefined),
              ),
            ),
          )
          return {
            session: { id: SessionId.make('s-1'), file: Option.none() },
            events: Effect.map(
              PubSub.subscribe(events),
              Stream.fromSubscription,
            ),
            prompt: message =>
              message === 'bye'
                ? PubSub.shutdown(events)
                : PubSub.publishAll(events, reply(message)).pipe(Effect.asVoid),
            steer: () => Effect.void,
          }
        }),
    }),
  )

/** `fabrica <args>` with the local engine at `socket` and `input` on stdin: its exit and what it printed. */
const talk = (
  socket: string,
  input: string | Stream.Stream<string>,
  ...args: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(' ')),
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide(
        Stdio.layerTest({
          stdin: (typeof input === 'string' ? Stream.make(input) : input).pipe(
            Stream.map(text => new TextEncoder().encode(text)),
          ),
        }),
      ),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

/** An engine with one project, `work`, on scripted talks: its socket and the count of agents closed. */
const talkEngine = Effect.gen(function* () {
  const tools = yield* Toolbox
  const root = yield* tempFolder('talk-cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  const closed = yield* Ref.make(0)
  const gone = yield* Deferred.make<void>()
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    git: gitOf(tools),
    talks: scriptedTalks({ closed, gone }),
  })
  const repo = yield* makeGitRepo(tools)
  const added = yield* talk(paths.socket, '', 'project', 'add', repo.work)
  expect(added.exit).toStrictEqual(Exit.void)
  return { socket: paths.socket, closed, gone }
})

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica talk',
  it => {
    it.effect(
      'streams the talk on the terminal, sends each line, and closes the talk at the end of stdin',
      () =>
        Effect.gen(function* () {
          const { socket, closed } = yield* talkEngine
          const { exit, out, err } = yield* talk(
            socket,
            'a toggle\n\nthe shortcut\n',
            'talk',
            'feature',
            '--project',
            'work',
            '--model',
            'anthropic/claude-opus-5-5',
          )
          expect(err).toStrictEqual([])
          expect(exit).toStrictEqual(Exit.void)
          expect(out[0]).toMatch(
            /^talk talk-\S+ · anthropic\/claude-opus-5-5: type a message and Enter to send it, Ctrl-D to end$/u,
          )
          expect(out.slice(1)).toStrictEqual([
            '> a toggle',
            'On it:',
            'Adding a toggle.',
            '→ get_ticket {"id":"fa-a1b2"}',
            '✗ get_ticket failed',
            '> the shortcut',
            'On it:',
            'Adding the shortcut.',
            '→ get_ticket {"id":"fa-a1b2"}',
            '✗ get_ticket failed',
          ])
          expect(yield* Ref.get(closed)).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'waits for the answer to the talk’s opening before it closes the talk',
      () =>
        Effect.gen(function* () {
          const { socket, closed } = yield* talkEngine
          const { exit, out } = yield* talk(
            socket,
            '',
            'talk',
            'refine',
            'docs/spec.md',
            '--project',
            'work',
            '--model',
            'anthropic/claude-opus-5-5',
          )
          expect(exit).toStrictEqual(Exit.void)
          expect(out.slice(1)).toStrictEqual([
            'fabrica: Refine docs/spec.md',
            'On it:',
            'Adding Refine docs/spec.md.',
            '→ get_ticket {"id":"fa-a1b2"}',
            '✗ get_ticket failed',
          ])
          expect(yield* Ref.get(closed)).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect('says the talk has ended when a line comes after it', () =>
      Effect.gen(function* () {
        const { socket, gone } = yield* talkEngine
        const { exit, out, err } = yield* talk(
          socket,
          Stream.concat(
            Stream.make('bye\n'),
            // The next line once the talk's agent has ended and the engine has let the talk go.
            Stream.fromEffect(Effect.as(Deferred.await(gone), 'after\n')),
          ),
          'talk',
          'feature',
          '--project',
          'work',
          '--model',
          'anthropic/claude-opus-5-5',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.hasDies(exit)).toBe(false)
        expect(out[1]).toBe('> bye')
        expect(err).toHaveLength(1)
        expect(err[0]).toMatch(/^fabrica: the talk talk-\S+ has ended$/u)
      }).pipe(Effect.scoped),
    )

    it.effect('prints each transcript entry as JSON with --json', () =>
      Effect.gen(function* () {
        const { socket } = yield* talkEngine
        const { exit, out } = yield* talk(
          socket,
          'a toggle\n',
          'talk',
          'feature',
          'Dark mode',
          '--project',
          'work',
          '--model',
          'anthropic/claude-opus-5-5',
          '--json',
        )
        expect(exit).toStrictEqual(Exit.void)
        const tags = out.map(each => {
          const entry: unknown = JSON.parse(each)
          return typeof entry === 'object' && entry !== null && '_tag' in entry
            ? entry._tag
            : expect.fail(`not an entry: ${each}`)
        })
        expect(tags).toStrictEqual([
          'message',
          'message',
          'text',
          'text',
          'tool_call',
          'tool_end',
          'turn_end',
        ])
        expect(onlyJson(out.slice(0, 1))).toMatchObject({
          _tag: 'message',
          role: 'user',
          text: 'a toggle',
        })
      }).pipe(Effect.scoped),
    )

    it.effect('says why a talk couldn’t be opened', () =>
      Effect.gen(function* () {
        const { socket } = yield* talkEngine
        const noModel = yield* talk(
          socket,
          '',
          'talk',
          'feature',
          '--project',
          'work',
        )
        expect(Exit.isFailure(noModel.exit)).toBe(true)
        expect(noModel.err).toStrictEqual([
          "fabrica: the talk couldn't be opened: the project's settings name no model: give the talk one",
        ])
        const notServed = yield* talk(
          socket,
          '',
          'talk',
          'run',
          '--project',
          'work',
          '--model',
          'anthropic/claude-opus-5-5',
        )
        expect(notServed.err).toStrictEqual([
          "fabrica: the talk couldn't be opened: the run talk isn't in this engine's release yet",
        ])
        const badModel = yield* talk(
          socket,
          '',
          'talk',
          'feature',
          '--project',
          'work',
          '--model',
          'opus',
        )
        expect(badModel.err).toStrictEqual([
          "fabrica: opus isn't a model: write it as provider/model, such as anthropic/claude-opus-5-5",
        ])
      }).pipe(Effect.scoped),
    )
  },
)
