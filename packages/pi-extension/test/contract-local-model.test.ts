import { Duration, Effect, Layer, Option, Schema } from 'effect'
import { mkdir, readFile } from 'node:fs/promises'
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

// The Pi contract for a local model (spec §12.5, §12.9, §24): the real pinned Pi in RPC mode, on a provider
// its catalog hasn't, `ollama`, as the model proxy points an agent at one: it takes the model named by
// `models.json`, and calls it in Chat Completions with the agent's token. Run on every Pi upgrade:
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

const ChatRequest = Schema.fromJsonString(
  Schema.Struct({ model: Schema.String }),
)

/** A local model on loopback that answers each call in text: each call's path, key and model. */
const localModel = Effect.acquireRelease(
  Effect.gen(function* () {
    const calls: Array<{
      readonly path: string | undefined
      readonly authorization: string | undefined
      readonly model: string
    }> = []
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        calls.push({
          path: request.url,
          authorization: request.headers.authorization,
          model: Schema.decodeUnknownSync(ChatRequest)(
            Buffer.concat(chunks).toString('utf8'),
          ).model,
        })
        const chunk = (choice: object) =>
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, ...choice }],
          })}\n\n`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          [
            chunk({
              delta: { role: 'assistant', content: 'Nothing to do.' },
              finish_reason: null,
            }),
            chunk({ delta: {}, finish_reason: 'stop' }),
            'data: [DONE]\n\n',
          ].join(''),
        )
      })
    })
    const baseUrl = yield* Effect.callback<string>(resume => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resume(
          typeof address === 'object' && address !== null
            ? Effect.succeed(`http://127.0.0.1:${address.port}/ollama`)
            : Effect.die('the local model has no port'),
        )
      })
    })
    return { calls, baseUrl, server }
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.closeAllConnections()
      server.close()
    }),
)

/** A real Pi starts, loads its extension and the model, and runs a model call: allow for a loaded machine. */
const timeout = 60_000

describe('Pi on a local model', () => {
  it.live(
    'takes the model models.json names on a provider its catalog hasn’t, and calls it with the agent’s token',
    () =>
      Effect.gen(function* () {
        const root = yield* tempFolder('pi-local-model')
        const worktree = join(root, 'worktree')
        const home = join(root, 'home')
        yield* Effect.promise(async () => {
          await mkdir(worktree)
          await mkdir(home)
        })
        const calls: Array<Call> = []
        const socket = yield* serve(root, answers(calls, { dirty: false }))
        const local = yield* localModel
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
                provider: 'ollama',
                baseUrl: local.baseUrl,
                localApi: 'openai-completions',
              },
            ],
            token: agentToken,
            model: Option.some({ provider: 'ollama', modelId: 'qwen2.5:7b' }),
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

        const settled = yield* agent.prompt('Work on your ticket.')
        expect(settled.aborted).toBe(false)
        expect(local.calls[0]).toEqual({
          path: '/ollama/chat/completions',
          authorization: `Bearer ${agentToken}`,
          model: 'qwen2.5:7b',
        })
      }),
    timeout,
  )
})
