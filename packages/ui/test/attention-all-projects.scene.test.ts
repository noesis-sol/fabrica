import { Option, Schema } from 'effect'
import {
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// The Needs your attention column under the sidebar's All projects scope (spec §18.3, Appendix A.2):
// each card carries its project's chip, the sidebar row's colour and two-digit label, before its kind
// tag; a project's own scope draws its cards without it.

const engine = EngineId.make('e-1')
const alpha = ProjectId.make('p-1')
const beta = ProjectId.make('p-2')
const epoch = StreamEpoch.make('epoch-1')
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const permission = decodeRequest({
  _tag: 'permission',
  project: alpha,
  id: 'perm-1',
  ticket: 'fa-7',
  session: 's-1',
  tool: 'bash',
  input: { command: 'rm -rf build/' },
  shown: { _tag: 'command', lines: ['rm -rf build/'] },
  why: 'rm is not on the allow list',
  openedAt: at - 3 * 60_000,
})

const task = decodeRequest({
  _tag: 'task',
  project: beta,
  ticket: 'fb-12',
  title: 'Make an API key for the staging bucket',
  openedAt: at - 120_000,
})

const status = (of: ProjectId): ProjectStatus =>
  new ProjectStatus({
    project: of,
    name: of,
    base: 'main',
    setUp: true,
    trusted: false,
    run: ProjectRunState.cases.idle.make({}),
    ready: 0,
  })

/** Two projects known to the sidebar, alpha first (chip 01, c1), beta second (chip 02, c2). */
const known: Model = update(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
    attention: Option.some([permission, task]),
    engineAttention: [
      { engine: localEngineName, requests: [permission, task] },
    ],
  },
  Message.ReceivedProjects({
    engine,
    name: localEngineName,
    items: [
      {
        _tag: 'snapshot',
        epoch,
        seq: 0,
        value: [status(alpha), status(beta)],
      } satisfies ProjectStatusItem,
    ],
  }),
).model

const cardChip = (name: string) =>
  within(role('listitem', { name }), selector('[data-chip]'))

describe('Needs your attention under All projects', () => {
  test("each card carries its project's chip beside its kind tag", () => {
    scene(
      { update, view },
      given(known),
      expectScene(cardChip('Approval fa-7')).toHaveText('01'),
      expectScene(cardChip('Approval fa-7')).toHaveAttr('data-chip', 'c1'),
      expectScene(cardChip('Approval fa-7')).toHaveClass('bg-c1'),
      expectScene(cardChip('Approval fa-7')).toHaveStyle('width', '22px'),
      expectScene(cardChip('Your task fb-12')).toHaveText('02'),
      expectScene(cardChip('Your task fb-12')).toHaveAttr('data-chip', 'c2'),
    )
  })

  test("a project's own scope draws its cards without a chip", () => {
    scene(
      { update, view },
      given({
        ...known,
        scope: Option.some({ engine: localEngineName, project: alpha }),
        attention: Option.some([permission]),
        engineAttention: [{ engine: localEngineName, requests: [permission] }],
      }),
      expectScene(role('listitem', { name: 'Approval fa-7' })).toExist(),
      expectScene(cardChip('Approval fa-7')).toBeAbsent(),
    )
  })
})
