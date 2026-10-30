import { Option } from 'effect'
import { RpcClientError } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { expect as expectScene, given, role, scene } from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import { ConnectionFailed } from '@fabrica/client'

import {
  AttemptFailure,
  attemptFailure,
  connectionRequirements,
} from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// A connection the connection process failed in words (spec §7.1): the local engine couldn't be
// started, so the attempt says why, in the app's notice, and is tried again, since the engine may
// answer later (a developer starts one, the disk is freed).

const start: Model = initialModel({ platform: 'darwin', release: '0.0.0' })

const failure =
  'no engine answers at /home/u/.local/state/fabrica/engine.sock, and this build bundles none to start'

describe('a local engine that could not be started', () => {
  test("is told from the client's error, by the words it carries", () => {
    const failed = new RpcClientError.RpcClientError({
      reason: new Socket.SocketOpenError({
        kind: 'Unknown',
        cause: new ConnectionFailed({ reason: failure }),
      }),
    })
    expect(attemptFailure(failed)).toEqual(
      AttemptFailure.Unreachable({ reason: failure }),
    )
  })

  test('is shown in its words, and tried again', () => {
    const failed = update(start, Message.FailedToConnect({ reason: failure }))
    expect((failed.commands ?? []).map(({ name }) => name)).toContain(
      'WaitToReconnect',
    )
    expect(Option.isSome(connectionRequirements(failed.model))).toBe(true)
    scene(
      { update, view },
      given(failed.model),
      expectScene(role('status')).toContainText(
        `Couldn't reach the engine (${failure}); trying again.`,
      ),
    )
  })
})
