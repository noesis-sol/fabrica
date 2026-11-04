import { Effect, Layer, Option, Redacted } from 'effect'

import {
  AgentRoleVariable,
  RunId,
  SessionId,
  type TalkId,
  TalkToolsVariable,
  toolJsonSchema,
} from '@fabrica/contracts'

import {
  AgentOwner,
  type AgentSendFailed,
  type AgentStartFailed,
  AgentStartFailure,
  PiAgent,
  piReaders,
} from '../agent'
import { openTalkControl } from '../control'
import { ModelProxy } from '../proxy'
import { RunHosting, RunHostingShape } from '../run/hosting'
import {
  type TalkAgent,
  TalkAgentFailed,
  type TalkAgentStart,
  TalkAgents,
  modelName,
  refusingTalkAgents,
} from './core'

// Talks' agents on `PiAgent` (spec §15.4, §12.1, §12.9): each talk's Pi runs in the project's checkout at
// the engine's own priority, its sessions in the talk's folder, resuming the kept session's file, with
// the mode's instructions appended to its system prompt. It only reads: it has the mode's tools, through
// the first-party extension and a control channel of the talk's own, and Pi's readers where the mode
// reads code, never its shell or writers. It reaches its model through the model proxy under an agent
// token of its own, counted to none of the project's runs, so no run's budget pays for it and no run's
// hold waits it out: a refused call ends its turn, and the talk's transcript says why (`core.ts`).

/** What the agents work from. */
export interface PiTalkAgentsConfig {
  /** The folder talks' control sockets are made in. */
  readonly sockets: string
}

/** Why a talk's agent didn't start, as the maintainer reads it. */
const startReason = (error: AgentStartFailed): string =>
  AgentStartFailure.$match(error.reason, {
    Exited: ({ stderr }) =>
      stderr.trim().length > 0
        ? `Pi exited as it started: ${stderr.trim()}`
        : error.message,
    Folders: ({ message }) => `its folders couldn't be made: ${message}`,
    Busy: () => error.message,
    Cancelled: () => error.message,
    Container: () => error.message,
    ContainerSetup: () => error.message,
    Spawn: () => error.message,
    Handshake: () => error.message,
  })

/** The tools a talk's Pi enables: the mode's, and Pi's readers where it reads code. */
export const talkAgentTools = ({
  tools,
  readsCode,
}: Pick<TalkAgentStart, 'tools' | 'readsCode'>): ReadonlyArray<string> => [
  ...(readsCode ? piReaders : []),
  ...tools.map(({ name }) => name),
]

export const makePiTalkAgents = Effect.fn('TalkAgents.make')(function* (
  config: PiTalkAgentsConfig,
) {
  const agents = yield* PiAgent
  const proxy = yield* ModelProxy

  const failed = (talk: TalkId) => (error: { readonly message: string }) =>
    new TalkAgentFailed({ talk, reason: error.message })

  const start = Effect.fn('TalkAgents.start')(function* (
    options: TalkAgentStart,
  ) {
    const { talk, model } = options
    const channel = yield* openTalkControl({
      talk,
      folder: config.sockets,
      call: options.call,
    }).pipe(Effect.mapError(failed(talk)))
    const granted = yield* proxy.grant({
      run: RunId.make(talk),
      ticket: Option.none(),
      session: Option.some(SessionId.make(talk)),
      model: modelName(model),
    })
    const agent = yield* agents
      .start({
        owner: AgentOwner.Talk({ talk, sessions: options.sessions }),
        project: options.project,
        worktree: options.checkout,
        providers: granted.providers,
        token: Redacted.value(granted.token),
        model: Option.some({
          provider: model.provider,
          modelId: model.model,
        }),
        tools: Option.some(talkAgentTools(options)),
        resume: options.resume,
        instructions: options.instructions,
        env: {
          ...channel.environment,
          [AgentRoleVariable]: 'talk',
          [TalkToolsVariable]: JSON.stringify(
            options.tools.map(toolJsonSchema),
          ),
        },
        projectTrusted: options.projectTrusted,
        // The engine's own priority: a talk isn't a worker (H73).
        nice: Option.none(),
      })
      .pipe(
        Effect.mapError(
          error => new TalkAgentFailed({ talk, reason: startReason(error) }),
        ),
      )
    const sent = (effect: Effect.Effect<unknown, AgentSendFailed>) =>
      effect.pipe(Effect.asVoid, Effect.mapError(failed(talk)))
    const started: TalkAgent = {
      session: agent.session,
      events: agent.events,
      prompt: message => sent(agent.prompt(message)),
      steer: message => sent(agent.steer(message)),
    }
    return started
  })

  return TalkAgents.of({ start })
})

/** Talks' agents over `config`, on the agents' service and the model proxy. */
export const piTalkAgents = (
  config: PiTalkAgentsConfig,
): Layer.Layer<TalkAgents, never, PiAgent | ModelProxy> =>
  Layer.effect(TalkAgents, makePiTalkAgents(config))

/**
 * Talks' agents on what the engine's runs run on: its agents' service and its model proxy. Where it
 * can't run a project they are refused, for the same reason, since it has neither to give them.
 */
export const hostedTalkAgents: Layer.Layer<TalkAgents, never, RunHosting> =
  Layer.unwrap(
    Effect.map(RunHosting, hosting =>
      RunHostingShape.$match(hosting, {
        Refused: ({ reason }) =>
          refusingTalkAgents(
            `a talk's agent runs as a run's workers do, and ${reason}`,
          ),
        Ready: ({ services, sockets }) =>
          piTalkAgents({ sockets }).pipe(
            Layer.provide(Layer.succeedContext(services)),
          ),
      }),
    ),
  )
