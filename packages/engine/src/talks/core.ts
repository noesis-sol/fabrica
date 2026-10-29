import {
  Context,
  Data,
  DateTime,
  type Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect'
import * as NodePath from 'node:path'

import {
  type AnyTool,
  type ModelChoice,
  ModelName,
  OpenedTalk,
  type ProjectId,
  type ProjectNotFound,
  type Resume,
  type SessionId,
  type TalkContext,
  TalkId,
  type TalkMode,
  TalkNotFound,
  TalkNotOpened,
  TranscriptEntry,
  type TranscriptItem,
} from '@fabrica/contracts'

import { type PiEvent, drawMessageId, makeTranscriptReader } from '../agent'
import { readFileText, writeFileWhole } from '../files'
import type { ProjectRecord } from '../projects'
import { Projects } from '../projects/service'
import { describeProblem } from '../settings'
import { type TranscriptFeed, makeTranscriptFeed } from '../transcript-feed'
import { drawBase36 } from '../workgraph/ids'

// Talks (spec §15.4): Pi sessions the engine runs with the maintainer, in the project's checkout, each
// in a mode with its context, its transcript streamed to a client's chat pane or the CLI's terminal.
// A mode is registered by name (`TalkModes`), each in its own file: its standing instructions, its
// tools (the engine's ticket tools among them), its opening prompt from the context, and whether its
// session is kept. A kept mode (the run talk) is one per project: opening it again gives the talk
// that is open, and after the engine restarts, the same talk on the same Pi session, resumed from
// the file the engine keeps for it. A talk runs on the project's model unless it is given one.
// The talk's agent is a port (`TalkAgents`), so the talks' rules are tested on a scripted session.

/** A talk's agent couldn't start, or refused a message. */
export class TalkAgentFailed extends Data.TaggedError('TalkAgentFailed')<{
  readonly talk: TalkId
  readonly reason: string
}> {
  override get message() {
    return `the talk ${this.talk}'s agent failed: ${this.reason}`
  }
}

/** What starting a talk's agent takes. */
export interface TalkAgentStart {
  readonly talk: TalkId
  readonly mode: TalkMode
  readonly project: ProjectId
  /** The project's checkout, the agent's working folder (read-only, §7.1). */
  readonly checkout: string
  readonly projectTrusted: boolean
  readonly model: ModelChoice
  /** The mode's standing instructions. */
  readonly instructions: string
  /** The engine's tools the agent is given. */
  readonly tools: ReadonlyArray<AnyTool>
  /** The folder Pi keeps the talk's sessions in. */
  readonly sessions: string
  /** A kept session's file to resume; none starts a new session. */
  readonly resume: Option.Option<string>
}

/** A talk's started agent; its scope's end closes it. */
export interface TalkAgent {
  readonly session: {
    readonly id: SessionId
    readonly file: Option.Option<string>
  }
  /** Subscribes in the scope: every event from the subscription on, ending when the agent exits. */
  readonly events: Effect.Effect<Stream.Stream<PiEvent>, never, Scope.Scope>
  /** Sends a prompt and waits for its turn to settle. */
  readonly prompt: (message: string) => Effect.Effect<void, TalkAgentFailed>
  /** Sends a message into the running turn. */
  readonly steer: (message: string) => Effect.Effect<void, TalkAgentFailed>
}

/** Starts talks' agents. */
export class TalkAgents extends Context.Service<
  TalkAgents,
  {
    readonly start: (
      options: TalkAgentStart,
    ) => Effect.Effect<TalkAgent, TalkAgentFailed, Scope.Scope>
  }
>()('@fabrica/engine/talks/TalkAgents') {}

/** Talks' agents that are refused, saying why: where the engine has no agents to give them. */
export const refusingTalkAgents = (reason: string): Layer.Layer<TalkAgents> =>
  Layer.succeed(TalkAgents)({
    start: ({ talk }) => Effect.fail(new TalkAgentFailed({ talk, reason })),
  })

/** The context a talk of `M` is opened on. */
export type TalkContextOf<M extends TalkMode> = Extract<
  TalkContext,
  { readonly _tag: M }
>

/** A talk's mode: what its agent is told, given and opened with. */
export interface TalkModeOf<M extends TalkMode> {
  /** Its session is kept across the engine's restarts, one talk per project. */
  readonly keep: boolean
  readonly instructions: string
  readonly tools: ReadonlyArray<AnyTool>
  /**
   * The prompt a new session opens with, the engine's message in the transcript; none waits for the
   * maintainer's first message.
   */
  readonly opening: (options: {
    readonly context: TalkContextOf<M>
    readonly project: ProjectRecord
  }) => Effect.Effect<Option.Option<string>, TalkNotOpened>
}

/** The modes this engine has, by name. */
export type TalkModesShape = { readonly [M in TalkMode]?: TalkModeOf<M> }

export class TalkModes extends Context.Service<TalkModes, TalkModesShape>()(
  '@fabrica/engine/talks/TalkModes',
) {}

/** A kept talk's file: its ID and its session's file, so a restarted engine resumes it. */
const KeptTalk = Schema.Struct({ talk: TalkId, session: Schema.String })
const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(KeptTalk))

/** Where the engine keeps a project's talks: `<data>/projects/<id>/talks/`. */
export const talksFolder = ({
  data,
  project,
}: {
  readonly data: string
  readonly project: ProjectId
}): string => NodePath.join(data, 'projects', project, 'talks')

/** The model's name, as a talk's header gives it. */
export const modelName = ({ provider, model }: ModelChoice): ModelName =>
  ModelName.make(`${provider}/${model}`)

/** What a talk is opened on: its project, its mode's context, and its model where it is given one. */
export interface TalkOpen {
  readonly project: ProjectId
  readonly context: TalkContext
  readonly model: Option.Option<ModelChoice>
}

export interface TalksShape {
  /** Opens a talk, or finds its kept mode's talk open in the project. */
  readonly open: (
    options: TalkOpen,
  ) => Effect.Effect<OpenedTalk, ProjectNotFound | TalkNotOpened>
  /** Sends the maintainer's message: a prompt, or into the running turn. */
  readonly send: (options: {
    readonly talk: TalkId
    readonly text: string
  }) => Effect.Effect<void, TalkNotFound>
  /** Ends the talk's agent; a kept talk's session stays, for the next open. */
  readonly close: (talk: TalkId) => Effect.Effect<void, TalkNotFound>
  /** The talk's transcript, as a snapshot or the patches after `resume`, until the talk closes. */
  readonly watchTranscript: (options: {
    readonly talk: TalkId
    readonly resume: Option.Option<Resume>
  }) => Stream.Stream<TranscriptItem, TalkNotFound>
}

export class Talks extends Context.Service<Talks, TalksShape>()(
  '@fabrica/engine/talks/Talks',
) {}

/** What the service works from. */
export interface TalksConfig {
  /** The engine's data folder (§7.2). */
  readonly data: string
  /** The scope talks' agents live in, ended with the engine's agents. */
  readonly scope: Scope.Scope
  /** How long streamed entries wait to cross (`stream_flush`), read as a talk opens. */
  readonly flush: Effect.Effect<Duration.Duration>
}

interface OpenTalk {
  readonly opened: OpenedTalk
  readonly project: ProjectId
  readonly mode: TalkMode
  readonly keep: boolean
  readonly agent: TalkAgent
  readonly feed: TranscriptFeed
  readonly scope: Scope.Closeable
  /** Whether a turn runs, so a message goes into it. */
  readonly turning: Ref.Ref<boolean>
  readonly lock: Semaphore.Semaphore
}

export const make = Effect.fn('Talks.make')(function* (config: TalksConfig) {
  const projects = yield* Projects
  const agents = yield* TalkAgents
  const modes = yield* TalkModes
  const talks = yield* Ref.make<ReadonlyMap<TalkId, OpenTalk>>(new Map())
  // Opens and closes take turns, so a kept mode is never opened twice.
  const turns = yield* Semaphore.make(1)

  const notOpened = (reason: string) => new TalkNotOpened({ reason })

  const find = (talk: TalkId) =>
    Effect.flatMap(Ref.get(talks), current =>
      Option.match(Option.fromUndefinedOr(current.get(talk)), {
        onNone: () => Effect.fail(new TalkNotFound({ talk })),
        onSome: Effect.succeed,
      }),
    )

  /** The talk's model: the one given, else the project's. */
  const modelOf = (options: TalkOpen) =>
    Option.match(options.model, {
      onSome: Effect.succeed,
      onNone: () =>
        projects.settings(options.project).pipe(
          Effect.catchTag('SettingsProblems', ({ problems }) =>
            Effect.fail(
              notOpened(
                `the project's settings can't be read: ${problems.map(describeProblem).join('; ')}`,
              ),
            ),
          ),
          Effect.flatMap(settings =>
            Option.match(settings.model, {
              onNone: () =>
                Effect.fail(
                  notOpened(
                    "the project's settings name no model: give the talk one",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
    })

  /** A kept talk's file: where it is, and what it holds where it can be read. */
  const keptFile = (project: ProjectId, mode: TalkMode) =>
    Effect.gen(function* () {
      // From the data folder down, so the project's folders are made where they are missing.
      const location = {
        root: config.data,
        path: NodePath.relative(
          config.data,
          NodePath.join(
            talksFolder({ data: config.data, project }),
            `${mode}.json`,
          ),
        ),
      }
      const text = yield* readFileText(location).pipe(
        Effect.map(Option.some),
        Effect.catchTag('FileMissing', () => Effect.succeedNone),
        Effect.catch(error =>
          Effect.as(
            Effect.logWarning(
              `the kept ${mode} talk of ${project} couldn't be read, so it starts afresh: ${error.message}`,
            ),
            Option.none<string>(),
          ),
        ),
      )
      return {
        location: Option.some(location),
        kept: Option.flatMap(text, decodeKept),
      }
    })

  /** Drops the talk from those open, unless another has taken its ID since. */
  const forget = (open: OpenTalk) =>
    Ref.update(talks, current => {
      if (current.get(open.opened.talk) !== open) return current
      const next = new Map(current)
      next.delete(open.opened.talk)
      return next
    })

  /** Writes `text` into the transcript as the engine's message, sent at once; `ended`, the turn's end after it. */
  const engineMessage = (feed: TranscriptFeed, text: string, ended = false) =>
    Effect.gen(function* () {
      const at = yield* DateTime.now
      yield* feed.write([
        TranscriptEntry.cases.message.make({
          id: yield* drawMessageId,
          role: 'engine',
          text,
          at,
        }),
        ...(ended
          ? [TranscriptEntry.cases.turn_end.make({ at, tokens: Option.none() })]
          : []),
      ])
      yield* feed.flush
    })

  /** Sends `text` to the talk: a prompt where no turn runs, else into the running turn. */
  const deliver = (talk: OpenTalk, text: string) =>
    talk.lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(talk.turning)) {
          yield* talk.agent
            .steer(text)
            .pipe(
              Effect.catch(error =>
                engineMessage(
                  talk.feed,
                  `The message wasn't delivered: ${error.reason}`,
                ),
              ),
            )
          return
        }
        yield* Ref.set(talk.turning, true)
        yield* Effect.forkIn(
          talk.agent.prompt(text).pipe(
            Effect.catch(error =>
              engineMessage(
                talk.feed,
                `The message wasn't delivered: ${error.reason}`,
                // No turn ran, or none will settle: its clients stop waiting on it.
                true,
              ),
            ),
            Effect.ensuring(talk.lock.withPermit(Ref.set(talk.turning, false))),
          ),
          talk.scope,
        )
      }),
    )

  const start = Effect.fn('Talks.start')(function* <M extends TalkMode>(
    options: TalkOpen,
    mode: M,
    context: TalkContextOf<M>,
  ) {
    const project = yield* projects.find(options.project)
    const definition = yield* Option.match(
      Option.fromUndefinedOr(modes[mode]),
      {
        onNone: () =>
          Effect.fail(
            notOpened(`the ${mode} talk isn't in this engine's release yet`),
          ),
        onSome: Effect.succeed,
      },
    )
    if (definition.keep) {
      const open = [...(yield* Ref.get(talks)).values()].find(
        talk => talk.project === project.id && talk.mode === mode,
      )
      if (open !== undefined) return open.opened
    }
    const model = yield* modelOf(options)
    const { location, kept } = definition.keep
      ? yield* keptFile(project.id, mode)
      : { location: Option.none(), kept: Option.none() }
    const talk = yield* Option.match(kept, {
      onSome: ({ talk: id }) => Effect.succeed(id),
      onNone: () =>
        Effect.map(drawBase36(12), random => TalkId.make(`talk-${random}`)),
    })
    const resume = Option.map(kept, ({ session }) => session)
    const first = Option.isSome(resume)
      ? Option.none<string>()
      : yield* definition.opening({ context, project })
    const scope = yield* Scope.fork(config.scope)
    const started = yield* Effect.exit(
      Effect.gen(function* () {
        const agent = yield* agents.start({
          talk,
          mode,
          project: project.id,
          checkout: project.path,
          projectTrusted: project.trusted,
          model,
          instructions: definition.instructions,
          tools: definition.tools,
          sessions: NodePath.join(
            talksFolder({ data: config.data, project: project.id }),
            definition.keep ? mode : talk,
          ),
          resume,
        })
        const events = yield* agent.events
        const feed = yield* makeTranscriptFeed({
          name: 'talk',
          flush: yield* config.flush,
          scope,
        })
        return { agent, events, feed }
      }).pipe(Scope.provide(scope)),
    )
    if (Exit.isFailure(started)) {
      yield* Scope.close(scope, Exit.void)
      return yield* Effect.failCause(started.cause).pipe(
        Effect.mapError(error => notOpened(error.reason)),
      )
    }
    const { agent, events, feed } = started.value
    if (Option.isSome(location) && Option.isSome(agent.session.file))
      yield* writeFileWhole(
        location.value,
        `${JSON.stringify({ talk, session: agent.session.file.value })}\n`,
        { mode: 0o600 },
      ).pipe(
        Effect.catch(error =>
          Effect.logWarning(
            `the kept ${mode} talk of ${project.id} couldn't be written, so a restart starts it afresh: ${error.message}`,
          ),
        ),
      )
    const open: OpenTalk = {
      opened: new OpenedTalk({
        talk,
        session: agent.session.id,
        model: modelName(model),
      }),
      project: project.id,
      mode,
      keep: definition.keep,
      agent,
      feed,
      scope,
      turning: yield* Ref.make(false),
      lock: yield* Semaphore.make(1),
    }
    const reader = yield* makeTranscriptReader()
    yield* Effect.forkIn(
      events.pipe(
        Stream.runForEach(event =>
          Effect.gen(function* () {
            const entries = yield* reader.read(event)
            yield* feed.write(entries)
            if (entries.some(TranscriptEntry.guards.turn_end)) yield* feed.flush
          }),
        ),
        // An agent that exits by itself leaves the talk saying so; a closed talk's feed has ended first.
        Effect.andThen(
          engineMessage(
            feed,
            "The talk's session has ended: open the talk again to go on.",
          ),
        ),
        Effect.andThen(feed.end),
        Effect.andThen(forget(open)),
        // Closed from outside the talk's scope, which this fiber is in.
        Effect.andThen(
          Effect.forkIn(Scope.close(scope, Exit.void), config.scope),
        ),
      ),
      scope,
    )
    yield* Scope.addFinalizer(scope, feed.end)
    yield* Ref.update(talks, current => new Map(current).set(talk, open))
    // The opening is the engine's message in the transcript, so a client sees a turn is due.
    if (Option.isSome(first))
      yield* Effect.andThen(
        engineMessage(feed, first.value),
        deliver(open, first.value),
      )
    return open.opened
  })

  const open = (options: TalkOpen) =>
    turns.withPermit(start(options, options.context._tag, options.context))

  const send = Effect.fn('Talks.send')(function* ({
    talk,
    text,
  }: {
    readonly talk: TalkId
    readonly text: string
  }) {
    const found = yield* find(talk)
    yield* found.feed.write([
      TranscriptEntry.cases.message.make({
        id: yield* drawMessageId,
        role: 'user',
        text,
        at: yield* DateTime.now,
      }),
    ])
    yield* found.feed.flush
    yield* deliver(found, text)
  })

  const close = Effect.fn('Talks.close')(function* (talk: TalkId) {
    const found = yield* turns.withPermit(
      Effect.gen(function* () {
        const open = yield* find(talk)
        yield* forget(open)
        return open
      }),
    )
    yield* Scope.close(found.scope, Exit.void)
  })

  const watchTranscript = ({
    talk,
    resume,
  }: {
    readonly talk: TalkId
    readonly resume: Option.Option<Resume>
  }) => Stream.unwrap(Effect.map(find(talk), found => found.feed.watch(resume)))

  return Talks.of({ open, send, close, watchTranscript })
})

/** The service over `config`, on the projects, the talks' agents and the modes. */
export const layer = (
  config: TalksConfig,
): Layer.Layer<Talks, never, Projects | TalkAgents | TalkModes> =>
  Layer.effect(Talks, make(config))
