import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Pull,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from 'effect'

import {
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Context as ModelContext,
  type Models,
  Type,
  hasApi,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  AgentRoleVariable,
  AnswerParameters,
  AnswerToolName,
  AnswerToolVariable,
  CommandSetting,
  type ModelChoice,
  type ModelName,
  type OrganName,
  type ProjectId,
  type ProjectSettings,
  type ProviderName,
  type RunId,
  SessionId,
  TicketId,
  type Tokens,
  ToolRefusal,
  answerTool,
  formatDurationMillis,
  parametersJsonSchema,
  toolJsonSchema,
} from '@fabrica/contracts'

import { PiAgent } from '../agent'
import { ControlRole, ControlServer, Outcome } from '../control'
import {
  type Billing,
  type PriceTable,
  type Spend,
  addCall,
  noSpend,
  piPriceTable,
  priceOf,
  spendFields,
} from '../cost'
import type { CredentialsHoldShape, UsageHoldShape } from '../holds'
import { Deadlines, coreShareVariables } from '../process'
import { type Caller, ModelProxy, Permits, ProxyEvent, Refusal } from '../proxy'
import { record } from '../run/records'
import { RATE_BACKOFF } from '../run/supervisor'
import type { RunLog } from '../runlog'
import { modelName } from '../talks'
import { Telemetry, TelemetryRow } from '../telemetry'
import { drawBase36 } from '../workgraph/ids'

// The organs' runtime (spec §16, H18, H86): an organ asks a model one question, through `pi-ai` with one
// forced `answer` tool, or through a short read-only Pi session in the checkout where it needs tools,
// ending in the same tool. The answer's arguments are decoded with the organ's Effect Schema, and one
// that doesn't decode is given back with the error, once. Each organ has `organs.<name>.model` (else the
// project's) and can be turned off. Calls go through the model proxy under a token of their own, so its
// permits and holds apply and the run's cost account counts them; a call refused for a usage limit or
// its credential waits out its hold as a worker's turn does and goes again (§14.2, §14.6), rather than
// fail ticket after ticket, and one refused for a rate limit backs off as a worker's does (§12.8). A
// limit doesn't count while its provider is held. Anything else that keeps one question from an answer,
// a defect among them, loses that answer alone: logged, written to the run's records, and the organ's
// queue goes on.

/** What an organ's question came to. */
export type OrganOutcome<A> = Data.TaggedEnum<{
  /** Its answer, decoded with the organ's schema, and what it spent. */
  Answered: { readonly answer: A; readonly spend: Spend }
  /** The organ is turned off: no model was called. */
  Disabled: {}
  /** The answer is lost, and said so; `reason` is why, and `spend` what it spent getting there. */
  NoResult: { readonly reason: string; readonly spend: Spend }
}>

interface OrganOutcomeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: OrganOutcome<this['A']>
}
export const OrganOutcome = Data.taggedEnum<OrganOutcomeDefinition>()

/** What keeps a question from its answer, which the organ's queue outlives. */
class AnswerLost extends Data.TaggedError('AnswerLost')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** What an organ asks. */
export interface OrganQuestion<A> {
  readonly organ: OrganName
  /** The ticket it asks about; none for a question of no ticket's (the reviewer's, the scout's). */
  readonly ticket: Option.Option<TicketId>
  /** Decodes the answer's arguments. */
  readonly answer: Schema.Codec<A, unknown>
  /** The `answer` tool's description, as the model reads it. */
  readonly description: string
  /** What the organ is, as the model is told it. */
  readonly instructions: string
  /** The question, read here so that a defect reading it loses this answer alone. */
  readonly prompt: Effect.Effect<string>
}

/** What an organ asks of a session. */
export interface OrganSessionQuestion<A> extends OrganQuestion<A> {
  /** The session's share of the machine's cores (§7.3, H56). */
  readonly cores: number
}

/** The holds of the run an organ's calls are counted to (§14.2, §14.6). */
export interface OrganHolds {
  readonly usage: Pick<UsageHoldShape, 'waitOut'>
  readonly credentials: Pick<CredentialsHoldShape, 'waitOut'>
  /** The providers the run's holds hold (`heldProviders`): their value now, then each change. */
  readonly held: Stream.Stream<ReadonlySet<ProviderName>>
}

/** Each wait's limit, in time awake (§7.7); while its provider is held it stops, and starts again at the lift. */
export interface OrganLimits {
  /** For one model call's answer, from its permit on. */
  readonly call: Duration.Duration
  /** For one turn of a session, from its permit on. */
  readonly session: Duration.Duration
}

export const DEFAULT_ORGAN_LIMITS: OrganLimits = {
  call: Duration.minutes(10),
  session: Duration.minutes(30),
}

/** What the runtime works from, read once where the run (or `init`) starts. */
export interface OrganConfig {
  readonly project: ProjectId
  /** The run its calls are counted to; `init` draws one for its scout. */
  readonly run: RunId
  /** The project's checkout, a session's working folder. */
  readonly checkout: string
  readonly projectTrusted: boolean
  /** The folder sessions' control sockets are made in. */
  readonly sockets: string
  readonly settings: Pick<ProjectSettings, 'model' | 'organs'>
  /** The run's records; none outside a run. */
  readonly log: Option.Option<RunLog['Service']>
  /** The run's holds; none outside a run, where a refusal loses the answer. */
  readonly holds: Option.Option<OrganHolds>
  /** How each provider's calls are paid for. */
  readonly billing: (provider: ProviderName) => Billing
  /** pi-ai's tables (`piPriceTable`), unless another is given. */
  readonly prices?: PriceTable
  readonly limits?: OrganLimits
  /** A rate limit's backoff, a worker's (`RATE_BACKOFF`) unless another is given. */
  readonly backoff?: Schedule.Schedule<Duration.Duration>
}

export interface OrganRuntime {
  /** Asks a model through `pi-ai`, its one tool forced. Fails with nothing an organ's queue must handle. */
  readonly ask: <A>(
    question: OrganQuestion<A>,
  ) => Effect.Effect<OrganOutcome<A>>
  /** Asks a short read-only Pi session in the checkout, ending in the same tool. */
  readonly session: <A>(
    question: OrganSessionQuestion<A>,
  ) => Effect.Effect<OrganOutcome<A>>
}

/** Pi's built-in tools a session has beside `answer`: those that only read. */
export const organSessionTools: ReadonlyArray<string> = [
  'read',
  'grep',
  'find',
  'ls',
  AnswerToolName,
]

/** What a model call's message reports it used, as orchestra's four (H65). */
const tokensOf = ({ usage }: AssistantMessage): Tokens => ({
  input: usage.input,
  output: usage.output,
  cache_write: usage.cacheWrite,
  cache_read: usage.cacheRead,
})

/**
 * Makes a model call its one tool: `pi-ai`'s provider-neutral choice has no way to force a tool, so
 * each API the proxy passes is told in its own words. No thinking is asked for, which Anthropic refuses
 * beside a forced tool. None for a model of an API the proxy doesn't pass.
 */
const forced = (
  models: Models,
  model: Model<Api>,
  context: ModelContext,
  options: {
    readonly apiKey: string
    readonly signal: AbortSignal
    readonly maxRetries: number
  },
) => {
  const name = AnswerToolName
  if (hasApi(model, 'anthropic-messages'))
    return Option.some(
      models.stream(model, context, {
        ...options,
        toolChoice: { type: 'tool', name },
      }),
    )
  if (hasApi(model, 'openai-responses'))
    return Option.some(
      models.stream(model, context, {
        ...options,
        toolChoice: { type: 'function', name },
      }),
    )
  if (hasApi(model, 'openai-completions'))
    return Option.some(
      models.stream(model, context, {
        ...options,
        toolChoice: { type: 'function', function: { name } },
      }),
    )
  if (hasApi(model, 'google-generative-ai'))
    return Option.some(
      models.stream(model, context, { ...options, toolChoice: 'any' }),
    )
  return Option.none()
}

/** Why a question lost its answer, in a line. */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/** What a question's work has to hand. */
interface Asking {
  readonly choice: ModelChoice
  readonly name: ModelName
  readonly session: SessionId
  readonly caller: Caller
  /** The latest refusal the proxy saw of the question's calls. */
  readonly refused: Ref.Ref<Option.Option<Refusal>>
  /** Adds what its calls used, and how many they were, to the question's spend. */
  readonly used: (tokens: Tokens, calls: number) => Effect.Effect<void>
}

/** The runtime over `config`, on the model proxy, its permits, the agents and the control channel. */
export const makeOrganRuntime = Effect.fn('Organs.make')(function* (
  config: OrganConfig,
) {
  const proxy = yield* ModelProxy
  const permits = yield* Permits
  const telemetry = yield* Telemetry
  const deadlines = yield* Deadlines
  const agents = yield* PiAgent
  const control = yield* ControlServer
  const models = builtinModels()
  const prices = config.prices ?? piPriceTable()
  const limits = config.limits ?? DEFAULT_ORGAN_LIMITS
  const backoff = config.backoff ?? RATE_BACKOFF

  /** Ends once `limit` has passed with `provider` not held, as the deadlines count time. */
  const limitPassed = (provider: ProviderName, limit: Duration.Duration) =>
    Option.match(config.holds, {
      onNone: () => deadlines.sleep(limit),
      onSome: ({ held }) =>
        Effect.gen(function* () {
          /** Ends when the provider first is as `wanted`; never, where the holds are gone before it is. */
          const until = (wanted: boolean) =>
            held.pipe(
              Stream.filter(providers => providers.has(provider) === wanted),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.never,
                  onSome: () => Effect.void,
                }),
              ),
            )
          for (;;) {
            const passed = yield* Effect.raceFirst(
              Effect.as(deadlines.sleep(limit), true),
              Effect.as(until(true), false),
            )
            if (passed) return
            yield* until(false)
          }
        }),
    })

  /** Waits up to `limit` for `effect`; past it, the answer is lost. */
  const within = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    provider: ProviderName,
    limit: Duration.Duration,
    what: string,
  ) =>
    Effect.raceFirst(
      effect,
      Effect.andThen(
        limitPassed(provider, limit),
        Effect.fail(
          new AnswerLost({
            reason: `${what} didn't end within ${formatDurationMillis(Duration.toMillis(limit))}`,
          }),
        ),
      ),
    )

  /** Waits for what holds `caller`'s provider to let its calls through, so a limit counts from there. */
  const permitted = (asking: Asking) =>
    Effect.scoped(
      permits.take({
        provider: asking.choice.provider,
        caller: asking.caller,
      }),
    )

  /**
   * A question's waits on `provider`'s refusals: each waits out what a refusal asks and says whether to
   * go again. A usage limit and a refused credential wait out their hold, with no holds to wait on not
   * at all; a rate limit backs off, one backoff for the question, until it is spent; a start that failed
   * goes no further (§12.9: no call to the provider has gone through in the run, so no hold takes it).
   */
  const waitsOn = (provider: ProviderName) =>
    Effect.map(
      Schedule.toStep(backoff),
      step =>
        (refusal: Refusal): Effect.Effect<boolean> =>
          Refusal.$match(refusal, {
            UsageLimited: ({ resetAt }) =>
              Option.match(config.holds, {
                onNone: () => Effect.succeed(false),
                onSome: holds =>
                  Effect.as(
                    holds.usage.waitOut({
                      ticket: Option.none(),
                      provider,
                      resetAt,
                    }),
                    true,
                  ),
              }),
            CredentialRefused: ({ account, reason }) =>
              Option.match(config.holds, {
                onNone: () => Effect.succeed(false),
                onSome: holds =>
                  Effect.as(
                    holds.credentials.waitOut({
                      ticket: Option.none(),
                      provider,
                      account,
                      reason,
                    }),
                    true,
                  ),
              }),
            RateLimited: ({ retryAfter }) =>
              Effect.gen(function* () {
                const delay = yield* step(
                  yield* Clock.currentTimeMillis,
                  undefined,
                ).pipe(
                  Effect.map(([, wait]) => Option.some(wait)),
                  Pull.catchDone(() => Effect.succeedNone),
                )
                if (Option.isNone(delay)) return false
                yield* deadlines.sleep(
                  Option.match(retryAfter, {
                    onNone: () => delay.value,
                    onSome: asked => Duration.max(asked, delay.value),
                  }),
                )
                return true
              }),
            StartFailed: () => Effect.succeed(false),
          }),
    )

  /** Writes a question's `organ` record and its telemetry row, and says so where its answer was lost. */
  const finish = Effect.fn('Organs.finish')(function* (input: {
    readonly organ: OrganName
    readonly ticket: Option.Option<TicketId>
    readonly name: Option.Option<ModelName>
    readonly session: SessionId
    readonly spend: Spend
    readonly calls: number
    readonly since: number
    readonly lost: Option.Option<string>
  }) {
    const outcome = Option.isNone(input.lost) ? 'answered' : 'no_result'
    const duration = Math.max(0, (yield* Clock.currentTimeMillis) - input.since)
    const ticket = Option.getOrUndefined(input.ticket)
    const { tokens, cost_usd } = spendFields(input.spend)
    const details = Option.toArray(input.lost).map(
      reason =>
        `ORGAN: the ${input.organ} organ lost ${ticket === undefined ? 'its answer' : `${ticket}'s answer`}: ${reason}`,
    )
    yield* Effect.forEach(details, line => Effect.logWarning(line), {
      discard: true,
    })
    yield* Option.match(config.log, {
      onNone: () => Effect.void,
      onSome: log =>
        record(
          log,
          {
            kind: 'organ',
            organ: input.organ,
            ...(ticket === undefined ? {} : { ticket }),
            outcome,
            ...Option.match(input.name, {
              onNone: () => ({}),
              onSome: model => ({ model }),
            }),
            ...(tokens === undefined ? {} : { tokens }),
            ...(cost_usd === undefined ? {} : { cost_usd }),
            turns: input.calls,
            session: input.session,
            duration_ms: duration,
          },
          details,
        ),
    })
    yield* telemetry.record(
      TelemetryRow.OrganCall({
        project: config.project,
        run: config.run,
        ticket,
        organ: input.organ,
        model: Option.getOrUndefined(input.name),
        duration: Duration.millis(duration),
        outcome,
        costUsd: Option.getOrUndefined(input.spend.costUsd),
      }),
    )
  })

  /**
   * One question: turned off it calls nothing; otherwise `work` runs under a session of its own, and
   * whatever but an interruption keeps it from an answer loses that answer alone.
   */
  const asked = <A>(
    question: OrganQuestion<A>,
    work: (asking: Asking) => Effect.Effect<A, unknown, Scope.Scope>,
  ): Effect.Effect<OrganOutcome<A>> =>
    Effect.gen(function* () {
      const organ = config.settings.organs[question.organ]
      if (!organ.enabled) return OrganOutcome.Disabled()
      const since = yield* Clock.currentTimeMillis
      const session = SessionId.make(`organ-${yield* drawBase36(12)}`)
      const spent = yield* Ref.make(noSpend)
      const calls = yield* Ref.make(0)
      const choice = Option.orElse(organ.model, () => config.settings.model)
      const name = Option.map(choice, modelName)
      const exit = yield* Effect.gen(function* () {
        if (Option.isNone(choice) || Option.isNone(name))
          return yield* new AnswerLost({
            reason: `neither organs.${question.organ}.model nor the project's model is set`,
          })
        const refused = yield* Ref.make(Option.none<Refusal>())
        yield* (yield* proxy.events).pipe(
          Stream.filter(event =>
            Option.contains(event.caller.session, session),
          ),
          Stream.runForEach(event =>
            ProxyEvent.$is('Refused')(event)
              ? Ref.set(refused, Option.some(event.refusal))
              : Effect.void,
          ),
          Effect.forkScoped,
        )
        return yield* work({
          choice: choice.value,
          name: name.value,
          session,
          caller: {
            run: config.run,
            ticket: Option.none(),
            session: Option.some(session),
            model: name.value,
          },
          refused,
          used: (tokens, count) =>
            Effect.andThen(
              Ref.update(calls, current => current + count),
              Ref.update(spent, current =>
                addCall(current, {
                  model: name.value,
                  tokens,
                  price: priceOf(prices, {
                    provider: choice.value.provider,
                    model: name.value,
                    tokens,
                    billing: config.billing(choice.value.provider),
                  }),
                }),
              ),
            ),
        })
      }).pipe(Effect.scoped, Effect.exit)
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        return yield* Effect.interrupt
      const spend = yield* Ref.get(spent)
      const lost = Exit.isFailure(exit)
        ? Option.some(reasonOf(exit.cause))
        : Option.none()
      yield* finish({
        organ: question.organ,
        ticket: question.ticket,
        name,
        session,
        spend,
        calls: yield* Ref.get(calls),
        since,
        lost,
      })
      return Exit.match(exit, {
        onSuccess: answer => OrganOutcome.Answered({ answer, spend }),
        onFailure: cause =>
          OrganOutcome.NoResult({ reason: reasonOf(cause), spend }),
      })
    })

  const ask = <A>(question: OrganQuestion<A>) =>
    asked(question, asking =>
      Effect.gen(function* () {
        const { provider, model: modelId } = asking.choice
        const prompt = yield* question.prompt
        const found = models.getModel(provider, modelId)
        if (found === undefined)
          return yield* new AnswerLost({
            reason: `pi-ai's catalog has no model ${asking.name}`,
          })
        const granted = yield* proxy.grant(asking.caller)
        const entry = Option.fromUndefinedOr(
          granted.providers.find(given => given.provider === provider),
        )
        if (Option.isNone(entry))
          return yield* new AnswerLost({
            reason: `the model proxy reaches no provider named ${provider}`,
          })
        const model: Model<Api> = { ...found, baseUrl: entry.value.baseUrl }
        const tool = answerTool({
          answer: question.answer,
          description: question.description,
        })
        const decode = Schema.decodeUnknownEffect(question.answer, {
          onExcessProperty: 'error',
        })
        const decodeEnvelope = Schema.decodeUnknownEffect(AnswerParameters, {
          onExcessProperty: 'error',
        })
        const tools = [
          {
            name: tool.name,
            description: tool.description,
            parameters: Type.Unsafe<unknown>(parametersJsonSchema(tool)),
          },
        ]
        const call = (messages: ReadonlyArray<Message>) =>
          Effect.tryPromise({
            try: signal =>
              Option.match(
                forced(
                  models,
                  model,
                  {
                    systemPrompt: question.instructions,
                    messages: [...messages],
                    tools,
                  },
                  {
                    // A subscription's placeholder, so pi-ai builds its kind of request.
                    apiKey: entry.value.apiKey ?? Redacted.value(granted.token),
                    signal,
                    // A refusal comes straight back, for its hold; the SDK would only ask again.
                    maxRetries: 0,
                  },
                ),
                {
                  onNone: () =>
                    Promise.reject(
                      new Error(
                        `the model proxy doesn't pass ${model.api}, which ${asking.name} speaks`,
                      ),
                    ),
                  onSome: stream => stream.result(),
                },
              ),
            catch: error =>
              new AnswerLost({
                reason: error instanceof Error ? error.message : String(error),
              }),
          })
        let messages: ReadonlyArray<Message> = [
          {
            role: 'user',
            content: prompt,
            timestamp: yield* Clock.currentTimeMillis,
          },
        ]
        let retried = false
        const waitOut = yield* waitsOn(provider)
        for (;;) {
          yield* permitted(asking)
          yield* Ref.set(asking.refused, Option.none())
          const reply = yield* within(
            call(messages),
            provider,
            limits.call,
            'the model call',
          )
          if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
            const refusal = yield* Ref.get(asking.refused)
            if (Option.isSome(refusal) && (yield* waitOut(refusal.value)))
              continue
            return yield* new AnswerLost({
              reason:
                reply.errorMessage ??
                `the model call ended ${reply.stopReason}`,
            })
          }
          yield* asking.used(tokensOf(reply), 1)
          const called = reply.content.find(
            part => part.type === 'toolCall' && part.name === AnswerToolName,
          )
          const decoded = yield* Effect.result(
            called === undefined || called.type !== 'toolCall'
              ? Effect.fail(`it didn't call ${AnswerToolName}`)
              : decodeEnvelope(called.arguments).pipe(
                  Effect.flatMap(({ answer }) => decode(answer)),
                  Effect.mapError(issue => issue.message),
                ),
          )
          if (Result.isSuccess(decoded)) return decoded.success
          if (retried)
            return yield* new AnswerLost({
              reason: `its answer failed to decode twice: ${decoded.failure}`,
            })
          retried = true
          const timestamp = yield* Clock.currentTimeMillis
          const text = `The answer was refused: ${decoded.failure}. Call ${AnswerToolName} again, with arguments that fit its schema.`
          messages = [
            ...messages,
            reply,
            called === undefined || called.type !== 'toolCall'
              ? { role: 'user', content: text, timestamp }
              : {
                  role: 'toolResult',
                  toolCallId: called.id,
                  toolName: called.name,
                  content: [{ type: 'text', text }],
                  isError: true,
                  timestamp,
                },
          ]
        }
      }),
    ).pipe(Effect.withSpan('Organs.ask'))

  const session = <A>(question: OrganSessionQuestion<A>) =>
    asked(question, asking =>
      Effect.gen(function* () {
        const { provider, model: modelId } = asking.choice
        const prompt = yield* question.prompt
        yield* permitted(asking)
        const ticket = TicketId.make(asking.session)
        const tool = answerTool({
          answer: question.answer,
          description: question.description,
        })
        const decode = Schema.decodeUnknownEffect(question.answer, {
          onExcessProperty: 'error',
        })
        // The answer, or what lost it.
        const answered = yield* Deferred.make<A, AnswerLost>()
        const take = (given: unknown) =>
          decode(given).pipe(
            Effect.matchEffect({
              onSuccess: answer =>
                Effect.asVoid(Deferred.succeed(answered, answer)),
              onFailure: issue =>
                Effect.fail(
                  ToolRefusal.cases.invalid.make({ issue: issue.message }),
                ),
            }),
          )
        const channel = yield* control.open({
          project: config.project,
          ticket,
          session: asking.session,
          role: ControlRole.Organ({ answer: take }),
          worktree: config.checkout,
          folder: config.sockets,
          questionWait: Duration.zero,
          checkOwn: {
            command: CommandSetting.cases.None.make({}),
            checkout: config.checkout,
            timeLimit: limits.session,
            cores: question.cores,
            nice: Option.none(),
          },
          mergeStanding: Effect.succeed('not_queued'),
        })
        yield* channel.outcomes.pipe(
          Stream.runForEach(outcome =>
            Outcome.$is('Unfinished')(outcome)
              ? Deferred.fail(
                  answered,
                  new AnswerLost({
                    reason: 'its session settled twice with no answer',
                  }),
                )
              : Outcome.$is('ToolFailed')(outcome)
                ? Deferred.fail(
                    answered,
                    new AnswerLost({
                      reason: `${outcome.tool} failed in the engine: ${outcome.reason}`,
                    }),
                  )
                : Effect.void,
          ),
          Effect.forkScoped,
        )
        const granted = yield* proxy.grant(asking.caller)
        const agent = yield* agents.start({
          ticket,
          project: config.project,
          worktree: config.checkout,
          providers: granted.providers,
          token: Redacted.value(granted.token),
          model: Option.some({ provider, modelId }),
          tools: Option.some(organSessionTools),
          resume: Option.none(),
          env: {
            ...channel.environment,
            ...coreShareVariables(question.cores),
            [AgentRoleVariable]: 'organ',
            [AnswerToolVariable]: JSON.stringify(toolJsonSchema(tool)),
          },
          projectTrusted: config.projectTrusted,
          // The engine's own priority: an organ isn't a worker (H73).
          nice: Option.none(),
        })
        // Pi gives a refused answer back to the model, once: refused by Pi's check of its JSON Schema,
        // which the engine never hears of, or by the organ's schema above.
        yield* (yield* agent.events).pipe(
          Stream.filter(
            event =>
              event.type === 'tool_execution_end' &&
              event.toolName === AnswerToolName &&
              event.isError,
          ),
          Stream.drop(1),
          Stream.runForEach(() =>
            Deferred.fail(
              answered,
              new AnswerLost({ reason: 'its answer was refused twice' }),
            ),
          ),
          Effect.forkScoped,
        )
        // Whether the provider was held during the turn: a hold on another caller's refusal outlasting
        // Pi's own retries ends the turn with no refusal of this session's, and no answer lost by it.
        const heldInTurn = yield* Ref.make(false)
        yield* Option.match(config.holds, {
          onNone: () => Effect.void,
          onSome: ({ held }) =>
            held.pipe(
              Stream.filter(providers => providers.has(provider)),
              Stream.runForEach(() => Ref.set(heldInTurn, true)),
              Effect.forkScoped,
              Effect.asVoid,
            ),
        })
        const waitOut = yield* waitsOn(provider)
        const turns = Effect.gen(function* () {
          let message = `${question.instructions}\n\n${prompt}`
          for (;;) {
            yield* Ref.set(asking.refused, Option.none())
            yield* Ref.set(heldInTurn, false)
            const came = yield* within(
              Effect.raceFirst(
                Effect.as(agent.prompt(message), Option.none<A>()),
                Effect.map(Deferred.await(answered), Option.some),
              ),
              provider,
              limits.session,
              "the session's turn",
            )
            if (Option.isSome(came)) return came.value
            const polled = yield* Deferred.poll(answered)
            if (Option.isSome(polled)) return yield* polled.value
            const refusal = yield* Ref.get(asking.refused)
            const waited =
              Option.isSome(refusal) && (yield* waitOut(refusal.value))
            if (!waited && !(yield* Ref.get(heldInTurn)))
              return yield* new AnswerLost({
                reason: 'its session settled with no answer',
              })
            yield* permitted(asking)
            message = `Your turn ended as ${provider} couldn't be called, and it may be called again: carry on, and end through ${AnswerToolName}.`
          }
        })
        const ended = yield* Effect.exit(turns)
        const stats = yield* Effect.option(agent.sessionStats)
        if (Option.isSome(stats))
          yield* asking.used(
            {
              input: stats.value.tokens.input,
              output: stats.value.tokens.output,
              cache_write: stats.value.tokens.cacheWrite,
              cache_read: stats.value.tokens.cacheRead,
            },
            stats.value.assistantMessages,
          )
        return yield* ended
      }),
    ).pipe(Effect.withSpan('Organs.session'))

  const runtime: OrganRuntime = { ask, session }
  return runtime
})
