import { Duration, Effect, Layer, Option, Schema } from 'effect'
import { mkdir, readFile } from 'node:fs/promises'
import { type IncomingHttpHeaders, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from '@effect/vitest'
import {
  ControlSocketVariable,
  ControlTokenVariable,
  PermissionsVariable,
  ProjectId,
} from '@fabrica/contracts'
import { Agent, Process, Proxy } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { answers, own, serve, token } from './control-server'

// The Pi contract for subscriptions (spec §12.9, §24, fab-mgi.2.4, fab-mgi.11): the real pinned Pi in RPC
// mode, configured as the model proxy configures an agent on a subscription, against a stub provider that
// records the request and refuses it. The placeholder must make Pi build the subscription's request, with
// nothing for the proxy to change but the token. `pi-ai` tells these requests apart by its key's text and
// its model's base URL, so each Pi upgrade runs this: `pnpm --filter @fabrica/pi-extension test:contract`.

const piPackage = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url),
)
const extension = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const PiManifest = Schema.Struct({ bin: Schema.Struct({ pi: Schema.String }) })

const piCli = Effect.map(
  Effect.promise(() => readFile(join(piPackage, 'package.json'), 'utf8')),
  text =>
    join(
      piPackage,
      Schema.decodeUnknownSync(PiManifest)(JSON.parse(text)).bin.pi,
    ),
)

const agentToken = 'a'.repeat(64)

interface Asked {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** A provider refusing every call with a client error, which Pi doesn't retry: what it was asked. */
const refusingProvider = Effect.acquireRelease(
  Effect.gen(function* () {
    const asked: Array<Asked> = []
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        asked.push({
          path: (request.url ?? '').split('?')[0] ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'recorded' },
          }),
        )
      })
    })
    const baseUrl = yield* Effect.callback<string>(resume => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resume(
          typeof address === 'object' && address !== null
            ? Effect.succeed(`http://127.0.0.1:${address.port}`)
            : Effect.die('the stub provider has no port'),
        )
      })
    })
    return { asked, baseUrl, server }
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.closeAllConnections()
      server.close()
    }),
)

/** The request Pi sends for a prompt, its provider configured as the proxy does on a subscription. */
const requestOf = (provider: string, modelId: string) =>
  Effect.gen(function* () {
    const root = yield* tempFolder('pi-subscription')
    const worktree = join(root, 'worktree')
    const home = join(root, 'home')
    yield* Effect.promise(async () => {
      await mkdir(worktree)
      await mkdir(home)
    })
    const socket = yield* serve(root, answers([], { dirty: false }))
    const stub = yield* refusingProvider
    const context = yield* Layer.build(
      Agent.layer({
        node: process.execPath,
        cli: yield* piCli,
        extension,
        data: join(root, 'data'),
        configRoot: join(root, 'agents'),
        limits: {
          handshake: Duration.seconds(30),
          answer: Duration.seconds(30),
          abort: Duration.seconds(5),
          reap: Duration.seconds(5),
        },
        reaperPoll: Duration.millis(200),
        reaperGrace: Duration.millis(500),
      }).pipe(
        Layer.provideMerge(
          Process.layer({
            hostEnvironment: {
              PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: home,
              LANG: 'C',
            },
            enginePriority: 0,
            priority: Process.hostPriority,
            listProcesses: Process.listProcesses,
            pipeHolders: Process.hostHolders({
              platform: process.platform,
              self: process.pid,
            }),
            self: process.pid,
            killGrace: Duration.millis(500),
            outputGrace: Duration.millis(200),
          }),
        ),
        Layer.provide(Process.layerClock),
      ),
    )
    const agent = yield* Effect.flatMap(Agent.PiAgent, agents =>
      agents.start({
        ticket: own,
        project: ProjectId.make('p1'),
        worktree,
        providers: [
          {
            provider,
            baseUrl: stub.baseUrl,
            ...Proxy.subscriptionEntry(provider, agentToken),
          },
        ],
        token: agentToken,
        model: Option.some({ provider, modelId }),
        tools: Option.none(),
        resume: Option.none(),
        env: {
          [ControlSocketVariable]: socket,
          [ControlTokenVariable]: token,
          [PermissionsVariable]: 'workspace',
        },
        projectTrusted: false,
        nice: Option.none(),
      }),
    ).pipe(Effect.provide(context))
    yield* agent.prompt('Say OK.')
    const [asked] = stub.asked
    return asked === undefined ? yield* Effect.die('Pi called no model') : asked
  })

const timeout = 60_000

describe('Pi on a subscription', () => {
  it.live(
    'builds the Claude subscription’s request for its placeholder',
    () =>
      Effect.gen(function* () {
        const { path, headers, body } = yield* requestOf(
          'anthropic',
          'claude-sonnet-4-5',
        )
        expect(path).toBe('/v1/messages')
        expect(headers.authorization).toBe(`Bearer sk-ant-oat01-${agentToken}`)
        expect(headers['x-api-key']).toBeUndefined()
        // The proxy's probe makes the same request: its headers are held to Pi's here.
        const { 'anthropic-beta': betas, ...others } =
          Proxy.claudeSubscriptionHeaders
        expect(headers).toMatchObject(others)
        for (const beta of (betas ?? '').split(','))
          expect(headers['anthropic-beta']).toContain(beta)
        expect(body).toContain(JSON.stringify(Proxy.claudeSubscriptionSystem))
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    'sends nothing a ChatGPT sign-in refuses, for its compat overrides',
    () =>
      Effect.gen(function* () {
        const { path, headers, body } = yield* requestOf('openai', 'gpt-5.1')
        expect(path).toBe('/responses')
        expect(headers.authorization).toBe(`Bearer ${agentToken}`)
        const sent: unknown = JSON.parse(body)
        expect(sent).not.toHaveProperty('prompt_cache_retention')
        expect(sent).not.toHaveProperty('prompt_cache_options')
        expect(sent).not.toHaveProperty('max_output_tokens')
        expect(sent).not.toHaveProperty('temperature')
        expect(body).not.toContain('configuration_update')
      }).pipe(Effect.scoped),
    timeout,
  )
})
