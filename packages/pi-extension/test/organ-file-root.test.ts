import { Effect, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  AnswerToolName,
  FileRootTool,
  answerTool,
  parametersJsonSchema,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { ControlEndpoint, type ExtensionEnvironment } from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi, PiTool } from '../src/pi'
import { WorkerToolNames } from '../src/tools'
import { type Call, answers, serve, token } from './control-server'

// The spec breakdown's `file_root` (spec §15.5, §16): an organ's session has it beside `answer` only
// where the engine says so, it goes through the control channel, and it doesn't end the turn.

const given = {
  description: 'The tree.',
  parameters: parametersJsonSchema(
    answerTool({ answer: Schema.Unknown, description: 'The tree.' }),
  ),
}

/** A fake of Pi's extension API: what the extension registered; its handlers are left to the role's tests. */
const fakePi = () => {
  const tools: Array<PiTool> = []
  const pi: PiApi = {
    on: () => () => undefined,
    registerTool: tool => {
      tools.push(tool)
    },
    registerProvider: () => undefined,
    appendEntry: () => undefined,
  }
  return { pi, tools }
}

const loaded = Effect.fn(function* (organFilesRoot: boolean) {
  const folder = yield* tempFolder('pi-file-root')
  const calls: Array<Call> = []
  const socket = yield* serve(folder, answers(calls, { dirty: false }))
  const environment: ExtensionEnvironment = {
    control: Option.some({ endpoint: ControlEndpoint.Unix({ socket }), token }),
    role: 'organ',
    answerTool: Option.some(given),
    talkTools: [],
    organFilesRoot,
    projectTrusted: false,
    configFolder: Option.none(),
    permissions: 'workspace',
    worktree: folder,
    home: Option.none(),
  }
  const fake = fakePi()
  yield* Effect.promise(() => makeExtension(environment)(fake.pi))
  return { ...fake, calls }
})

describe('The breakdown organ’s file_root', () => {
  it.effect('is only an organ’s where the engine says so', () =>
    Effect.gen(function* () {
      const plain = yield* loaded(false)
      expect(plain.tools.map(tool => tool.name)).toEqual([AnswerToolName])
      const filing = yield* loaded(true)
      expect(filing.tools.map(tool => tool.name)).toEqual([
        FileRootTool.name,
        AnswerToolName,
      ])
      expect(WorkerToolNames.has(FileRootTool.name)).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect('reaches the engine, and leaves the turn going', () =>
    Effect.gen(function* () {
      const { tools, calls } = yield* loaded(true)
      const tool = tools.find(({ name }) => name === FileRootTool.name)
      if (tool === undefined) throw new Error('no file_root')
      const result = yield* Effect.promise(() =>
        tool.execute(
          'call-1',
          {
            root: {
              title: 'The shop',
              description: 'Builds the whole shop.',
            },
          },
          undefined,
        ),
      )
      expect(calls.map(({ rpc }) => rpc)).toEqual(['file_root'])
      expect(result.terminate).toBeUndefined()
      expect(result.details).toMatchObject({ root: 'fab-root' })
    }).pipe(Effect.scoped),
  )
})
