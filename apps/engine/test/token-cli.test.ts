import { Effect, Exit } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { fabrica, onlyJson } from './tickets-engine'

// `fabrica token create|list|revoke` (spec §19, §9.3): run as the CLI's entry runs it, against an
// engine started in a temporary data folder. A token is printed once, as it is made; it is listed by
// name, never with its secret, and revoked by name.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** An engine started in a temporary data folder, for the test's scope; its local socket. */
const testEngine = Effect.gen(function* () {
  const root = yield* tempFolder('token-cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  yield* Daemon.startEngine({ paths, host, release: '1.2.3' })
  return paths.socket
})

describe('fabrica token', () => {
  it.live('makes a token, prints it once, lists it and revokes it', () =>
    Effect.gen(function* () {
      const socket = yield* testEngine

      const empty = yield* fabrica(socket, 'token', 'list')
      expect(empty.exit).toStrictEqual(Exit.void)
      expect(empty.out).toStrictEqual([
        'no pairing tokens: make one with `fabrica token create <name>`',
      ])

      const created = yield* fabrica(socket, 'token', 'create', 'laptop')
      expect(created.exit).toStrictEqual(Exit.void)
      const [heading, secret, note] = (created.out[0] ?? '').split('\n')
      expect(heading).toBe('token laptop:')
      expect(secret).toMatch(/^fabrica_[0-9a-f]{64}$/u)
      expect(note).toBe('it is shown only now: the engine keeps only its hash')

      const json = yield* fabrica(socket, 'token', 'create', 'desk', '--json')
      expect(json.exit).toStrictEqual(Exit.void)
      expect(onlyJson(json.out)).toStrictEqual({
        name: 'desk',
        token: expect.stringMatching(/^fabrica_[0-9a-f]{64}$/u),
      })

      const listed = yield* fabrica(socket, 'token', 'list')
      expect(listed.out.join('\n')).toMatch(
        /^desk {4}made \S+ {2}never used\nlaptop {2}made \S+ {2}never used$/u,
      )
      expect(listed.out.join('\n')).not.toContain(secret)
      const listedJson = yield* fabrica(socket, 'token', 'list', '--json')
      expect(onlyJson(listedJson.out)).toStrictEqual([
        { name: 'desk', createdAt: expect.any(Number), lastUsedAt: null },
        { name: 'laptop', createdAt: expect.any(Number), lastUsedAt: null },
      ])

      const revoked = yield* fabrica(socket, 'token', 'revoke', 'laptop')
      expect(revoked.exit).toStrictEqual(Exit.void)
      expect(revoked.out).toStrictEqual([
        'revoked laptop: the engine refuses it from now on, and has closed its connections',
      ])
      const left = yield* fabrica(socket, 'token', 'list', '--json')
      expect(onlyJson(left.out)).toMatchObject([{ name: 'desk' }])
    }).pipe(Effect.scoped),
  )

  it.live('says why a token couldn’t be made or revoked', () =>
    Effect.gen(function* () {
      const socket = yield* testEngine
      yield* fabrica(socket, 'token', 'create', 'laptop')

      const taken = yield* fabrica(socket, 'token', 'create', 'laptop')
      expect(Exit.isFailure(taken.exit)).toBe(true)
      expect(taken.err).toStrictEqual([
        'fabrica: a token named laptop exists already: revoke it, or name this one otherwise',
      ])

      const unknown = yield* fabrica(socket, 'token', 'revoke', 'desk')
      expect(Exit.isFailure(unknown.exit)).toBe(true)
      expect(unknown.err).toStrictEqual([
        'fabrica: the engine has no token named desk',
      ])
    }).pipe(Effect.scoped),
  )
})
