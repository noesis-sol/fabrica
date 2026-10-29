import { Effect, Exit, Schema } from 'effect'

import { expect, layer } from '@effect/vitest'
import { ProjectInfo } from '@fabrica/contracts'
import { layerToolbox } from '@fabrica/testkit'

import { fabrica, onlyJson, testEngine } from './tickets-engine'

// `fabrica project trust|untrust` (spec §19, §12.1, §20.2): run as the CLI's entry runs it, against
// an engine started in a temporary data folder with one project, `work`, added untrusted; the user
// trusts it and takes the trust back, and `project list` says which it is.

const decodeInfos = Schema.decodeUnknownSync(Schema.Array(ProjectInfo))

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica project trust',
  it => {
    it.effect('trusts a project and takes the trust back', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const trustedOf = Effect.map(
          fabrica(socket, 'project', 'list', '--json'),
          ({ out }) =>
            decodeInfos(onlyJson(out)).map(({ id, trusted }) => [id, trusted]),
        )
        expect(yield* trustedOf).toStrictEqual([['work', false]])

        const trusted = yield* fabrica(socket, 'project', 'trust', 'work')
        expect(trusted.exit).toStrictEqual(Exit.void)
        expect(trusted.out).toStrictEqual([
          'trusted work: its agents started from now on load its own .pi/ settings and packages, which run code from its files with your permissions',
        ])
        expect(yield* trustedOf).toStrictEqual([['work', true]])
        const listed = yield* fabrica(socket, 'project', 'list')
        expect(listed.out.join('\n')).toMatch(
          /^work {2}main {2}not set up {2}trusted {2}\//u,
        )

        const untrusted = yield* fabrica(
          socket,
          'project',
          'untrust',
          'work',
          '--json',
        )
        expect(untrusted.exit).toStrictEqual(Exit.void)
        expect(onlyJson(untrusted.out)).toStrictEqual({
          project: 'work',
          trusted: false,
        })
        expect(yield* trustedOf).toStrictEqual([['work', false]])
      }).pipe(Effect.scoped),
    )

    it.effect('says why a project couldn’t be trusted', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const unknown = yield* fabrica(socket, 'project', 'trust', 'nothing')
        expect(Exit.isFailure(unknown.exit)).toBe(true)
        expect(unknown.err).toStrictEqual([
          'fabrica: the engine has no project nothing',
        ])
        const notAnId = yield* fabrica(socket, 'project', 'untrust', 'No Id!')
        expect(Exit.isFailure(notAnId.exit)).toBe(true)
        expect(notAnId.err).toStrictEqual([
          "fabrica: No Id! isn't a project's ID",
        ])
      }).pipe(Effect.scoped),
    )
  },
)
