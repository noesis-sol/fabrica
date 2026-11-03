import { Effect, Option, Queue, Redacted, Schema, Stream } from 'effect'

import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from '@earendil-works/pi-ai'
import {
  CredentialInfo,
  CredentialNotFound,
  CredentialStoreFailed,
  type CredentialValue,
  LoginFailed,
  LoginNotWaiting,
  LoginStep,
  type ProviderName,
  SecretRpcs,
} from '@fabrica/contracts'

import { drawToken } from '../control/token'
import { makeSubscriptions } from '../proxy/oauth'
import {
  type EngineCredentials,
  RunHosting,
  RunHostingShape,
} from '../run/hosting'
import { ApiKey, Kept, SecretName } from '../secrets'

// The Secrets group's handlers (spec §8.1, §20.3): model credentials in the engine's secret store, the
// same store its runs' model proxy reads. Keys are set by name, listed by name, and never sent back. A
// sign-in runs in the engine, through `pi-ai`, with the store as its credential store: what it says goes
// to the client that asked, as a stream, and what it asks comes back through `credentials.answerLogin`,
// under an id only that client was told. The client going ends the sign-in. Every sign-in opens by saying
// that a provider's terms are the user's to check.

/** What every sign-in says first (§20.3). */
export const termsNotice =
  "Whether this provider's terms allow its subscription in a third-party agent is yours to check."

/** The sign-in's answer waited on: at most one for each, as `pi-ai`'s sign-ins ask one thing at a time. */
type Waiting = (answer: string) => void

const decodeName = Schema.decodeUnknownOption(SecretName)

/** A text `pi-ai` may leave out or blank, which the protocol's words never are. */
const wordsOf = (text: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(text), words => words.trim() !== '')

/** What `pi-ai`'s event tells the client. */
const stepsOf = (event: AuthEvent): ReadonlyArray<LoginStep> => {
  switch (event.type) {
    case 'auth_url':
      return [
        LoginStep.cases.open_url.make({
          url: event.url,
          instructions: wordsOf(event.instructions),
        }),
      ]
    case 'device_code':
      return [
        LoginStep.cases.device_code.make({
          url: event.verificationUri,
          code: event.userCode,
        }),
      ]
    case 'info':
    case 'progress':
      return Option.toArray(
        Option.map(wordsOf(event.message), text =>
          LoginStep.cases.waiting.make({ text }),
        ),
      )
  }
}

/** What `pi-ai`'s question asks the client. */
const askedOf = (login: string, prompt: AuthPrompt): LoginStep =>
  LoginStep.cases.asked.make({
    login,
    message: prompt.message,
    placeholder:
      prompt.type === 'select' ? Option.none() : wordsOf(prompt.placeholder),
    secret: prompt.type === 'secret',
    choices:
      prompt.type === 'select'
        ? prompt.options.map(({ id, label }) => ({ id, label }))
        : [],
  })

const listed = (name: SecretName, kept: Kept): CredentialInfo =>
  CredentialInfo.make({
    name,
    ...Kept.$match(kept, {
      Key: ({ provider }) => ({ kind: 'key' as const, provider }),
      Command: ({ provider }) => ({ kind: 'command' as const, provider }),
      OAuth: ({ provider }) => ({
        kind: 'oauth' as const,
        provider: Option.some(provider),
      }),
    }),
  })

/** The Secrets group's handlers. */
export const secretsHandlers = SecretRpcs.toLayer(
  Effect.gen(function* () {
    const hosting = yield* RunHosting
    const credentials = RunHostingShape.$match(hosting, {
      Ready: ({ credentials }) => Option.fromUndefinedOr(credentials),
      Refused: ({ credentials }) => Option.fromUndefinedOr(credentials),
    })
    /** Why there is no store: what the hosting says, where it says. */
    const noStore = RunHostingShape.$match(hosting, {
      Ready: () => 'this engine has no secret store',
      Refused: ({ reason }) => reason,
    })
    const store: Effect.Effect<EngineCredentials, CredentialStoreFailed> =
      Option.match(credentials, {
        onNone: () =>
          Effect.fail(new CredentialStoreFailed({ reason: noStore })),
        onSome: Effect.succeed,
      })
    const failed = (error: { readonly message: string }) =>
      new CredentialStoreFailed({ reason: error.message })

    /** The answers the engine's running sign-ins wait on, by the sign-in's id. */
    const waiting = new Map<string, Waiting>()

    const list = Effect.gen(function* () {
      const { secrets } = yield* store
      const names = yield* secrets.list.pipe(Effect.mapError(failed))
      const kept = yield* Effect.forEach(
        names,
        name =>
          secrets
            .read(name)
            .pipe(
              Effect.mapError(failed),
              Effect.map(Option.map(kept => listed(name, kept))),
            ),
        { concurrency: 'unbounded' },
      )
      return kept.flatMap(Option.toArray)
    })

    const set = (options: {
      readonly name: string
      readonly value: CredentialValue
      readonly provider: Option.Option<ProviderName>
    }) =>
      Effect.gen(function* () {
        const { secrets } = yield* store
        const name = decodeName(options.name)
        if (Option.isNone(name))
          return yield* new CredentialStoreFailed({
            reason: `a credential's name is up to 128 letters, digits, dots, dashes and underscores, starting with a letter or digit: ${options.name} isn't one`,
          })
        const key =
          options.value._tag === 'key'
            ? ApiKey.Key({ key: options.value.key })
            : ApiKey.Command({ command: options.value.command })
        yield* secrets
          .set(name.value, key, Option.getOrUndefined(options.provider))
          .pipe(Effect.mapError(failed))
      })

    const remove = (name: string) =>
      Effect.gen(function* () {
        const { secrets } = yield* store
        const kept = decodeName(name)
        if (Option.isNone(kept)) return yield* new CredentialNotFound({ name })
        const removed = yield* secrets
          .remove(kept.value)
          .pipe(Effect.mapError(failed))
        if (!removed) return yield* new CredentialNotFound({ name })
      })

    const login = (provider: ProviderName) =>
      Stream.callback<LoginStep, LoginFailed>(queue =>
        Effect.gen(function* () {
          const refused = (reason: string) =>
            new LoginFailed({ provider, reason })
          const { secrets, providers } = yield* store.pipe(
            Effect.mapError(({ reason }) => refused(reason)),
          )
          const subscriptions = makeSubscriptions({ secrets, providers })
          if (!subscriptions.signsIn(provider))
            return yield* refused(`${provider} has no sign-in in pi-ai`)
          const id = Redacted.value(yield* drawToken)
          const offer = (step: LoginStep) => Queue.offerUnsafe(queue, step)
          const aborting = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            controller =>
              Effect.sync(() => {
                waiting.delete(id)
                controller.abort(new Error('the sign-in was dropped'))
              }),
          )
          const interaction: AuthInteraction = {
            signal: aborting.signal,
            notify: event => stepsOf(event).forEach(offer),
            prompt: prompt =>
              new Promise<string>((resolve, reject) => {
                const signals = [
                  aborting.signal,
                  ...(prompt.signal === undefined ? [] : [prompt.signal]),
                ]
                const abort = AbortSignal.any(signals)
                const gone = () => {
                  waiting.delete(id)
                  reject(abort.reason)
                }
                if (abort.aborted) return gone()
                abort.addEventListener('abort', gone, { once: true })
                waiting.set(id, answer => {
                  abort.removeEventListener('abort', gone)
                  resolve(answer)
                })
                offer(askedOf(id, prompt))
              }),
          }
          offer(LoginStep.cases.terms.make({ text: termsNotice }))
          yield* subscriptions.login(provider, interaction).pipe(
            Effect.matchEffect({
              onFailure: ({ reason }) =>
                Queue.fail(queue, refused(reason)).pipe(Effect.asVoid),
              onSuccess: () =>
                Effect.andThen(
                  Effect.sync(() =>
                    offer(
                      LoginStep.cases.signed_in.make({
                        account: Option.some(provider),
                      }),
                    ),
                  ),
                  Queue.end(queue),
                ).pipe(Effect.asVoid),
            }),
            Effect.forkScoped,
          )
        }).pipe(
          Effect.catch(error => Queue.fail(queue, error).pipe(Effect.asVoid)),
        ),
      )

    const answerLogin = (options: {
      readonly login: string
      readonly answer: Redacted.Redacted<string>
    }) =>
      Effect.gen(function* () {
        const waiter = waiting.get(options.login)
        if (waiter === undefined)
          return yield* new LoginNotWaiting({ login: options.login })
        waiting.delete(options.login)
        waiter(Redacted.value(options.answer))
      })

    return SecretRpcs.of({
      'credentials.set': set,
      'credentials.list': () => list,
      'credentials.remove': ({ name }) => remove(name),
      'credentials.login': ({ provider }) => login(provider),
      'credentials.answerLogin': answerLogin,
    })
  }),
)
