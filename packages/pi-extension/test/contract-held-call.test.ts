import { Duration, Effect, Fiber, Layer, Option, Schema, Stream } from 'effect'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from '@effect/vitest'
import {
  ControlSocketVariable,
  ControlTokenVariable,
  PermissionsVariable,
  ProjectId,
} from '@fabrica/contracts'
import { Agent, Process } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { type Call, answers, own, serve, token } from './control-server'

// The Pi contract for a call the model proxy holds (spec §12.9, §14.2, §14.6, §24): the real pinned Pi in
// RPC mode against a provider that takes the call and gives no response head, as the proxy does while a
// hold keeps the call at its permit. Pi's idle timeout, set short here, ends the call, its retries run
// out, and its turn settles on the error with nothing reported to the engine: the event the supervisor
// tells this end by, `run/supervisor.ts`'s `HoldOutlasted`. Run on every Pi upgrade:
// `pnpm --filter @fabrica/pi-extension test:contract`.

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

const agentToken = 'agent-token-1'

/** Pi's settings, for its timeout and its one retry to take no longer than a test should. */
const shortTimeouts = {
  httpIdleTimeoutMs: 500,
  retry: { maxRetries: 1, baseDelayMs: 10 },
}

/** A provider that takes each call and never answers it: how many it was given. */
const silentProvider = Effect.acquireRelease(
  Effect.gen(function* () {
    const asked = { calls: 0 }
    const server = createServer(request => {
      request.resume()
      request.on('end', () => {
        asked.calls += 1
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

/** A real Pi starts, loads its extension and the model, and runs a model call: allow for a loaded machine. */
const timeout = 60_000

describe('Pi on a call the proxy holds', () => {
  it.live(
    'times the call out and settles on the error, with no response head and nothing reported',
    () =>
      Effect.gen(function* () {
        const root = yield* tempFolder('pi-held-call')
        const worktree = join(root, 'worktree')
        const home = join(root, 'home')
        yield* Effect.promise(async () => {
          await mkdir(join(worktree, '.pi'), { recursive: true })
          await mkdir(home)
          await writeFile(
            join(worktree, '.pi', 'settings.json'),
            JSON.stringify(shortTimeouts),
          )
        })
        const calls: Array<Call> = []
        const socket = yield* serve(root, answers(calls, { dirty: false }))
        const stub = yield* silentProvider
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
                provider: 'anthropic',
                baseUrl: stub.baseUrl,
                apiKey: agentToken,
              },
            ],
            token: agentToken,
            model: Option.some({
              provider: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            }),
            tools: Option.none(),
            resume: Option.none(),
            env: {
              [ControlSocketVariable]: socket,
              [ControlTokenVariable]: token,
              [PermissionsVariable]: 'workspace',
            },
            projectTrusted: true,
            nice: Option.none(),
          }),
        ).pipe(Effect.provide(context))

        const heard = yield* (yield* agent.events).pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
          Effect.forkScoped,
        )
        const settled = yield* agent.prompt('Work on your ticket.')
        const events = yield* Fiber.join(heard)
        expect(settled.aborted).toBe(false)
        // Its last message tells the end: the model's call failed.
        const replies = events.flatMap(event =>
          event.type === 'message_end' && event.message.role === 'assistant'
            ? [event.message.stopReason]
            : [],
        )
        expect(replies).toEqual(['error', 'error'])
        // The call and its retry, each ending on the timeout.
        expect(stub.asked.calls).toBe(2)
        // Nothing is the agent's to answer for: no nudge, no call, and no report of it as unfinished.
        expect(calls).toEqual([])
      }),
    timeout,
  )
})
