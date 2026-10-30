import { Effect, Option } from 'effect'
import { writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { wslEngineName } from '@fabrica/client'
import { EngineId } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  EngineAddress,
  KnownEngine,
  type SecretBox,
  makeAppState,
  stateFileName,
} from '../src/main/state'

// The engine in WSL2 the Windows app reaches at launch, of those it knows: the one kept last, which
// the app's state names, so with two distributions kept, the one Add engine installed or found up to
// date last is the app's at the next start (fab-mgi.108).

/** A stand-in for safeStorage, which the known engines never reach. */
const secrets: SecretBox = {
  unavailable: () => Option.none(),
  encrypt: text => Buffer.from(text),
  decrypt: bytes => Buffer.from(bytes).toString('utf8'),
}

const inWsl = (distro: string) =>
  KnownEngine.make({
    name: wslEngineName(distro),
    address: EngineAddress.cases.Wsl.make({ distro }),
    engine: EngineId.make(`e-wsl-${distro}`),
    protocol: 1,
  })

const server = KnownEngine.make({
  name: 'server-1',
  address: EngineAddress.cases.Ssh.make({ destination: 'me@server-1' }),
  engine: EngineId.make('e-server-1'),
  protocol: 1,
})

describe('the engine in WSL2 kept last', () => {
  it.effect(
    'is the one the app reaches at the next start, kept again or not',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('wsl-kept-last')
          const state = yield* makeAppState({ folder, secrets })
          expect(yield* state.keptWslDistro).toEqual(Option.none())
          yield* state.saveEngine(inWsl('Debian'))
          yield* state.saveEngine(inWsl('Ubuntu'))
          // An engine on another host kept after them changes nothing.
          yield* state.saveEngine(server)
          expect(yield* state.keptWslDistro).toEqual(Option.some('Ubuntu'))
          // Kept again, the first stays where it was among the known engines, and is the one kept last.
          yield* state.saveEngine(
            KnownEngine.make({ ...inWsl('Debian'), protocol: 2 }),
          )
          const restarted = yield* makeAppState({ folder, secrets })
          expect((yield* restarted.engines).map(({ name }) => name)).toEqual([
            'WSL Debian',
            'WSL Ubuntu',
            'server-1',
          ])
          expect(yield* restarted.keptWslDistro).toEqual(Option.some('Debian'))
        }),
      ),
  )

  it.effect('is, once it is forgotten, the last other one in WSL2', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('wsl-kept-last')
        const state = yield* makeAppState({ folder, secrets })
        yield* state.saveEngine(inWsl('Debian'))
        yield* state.saveEngine(inWsl('Ubuntu'))
        yield* state.saveEngine(inWsl('Alpine'))
        yield* state.saveEngine(inWsl('Debian'))
        yield* state.removeEngine(wslEngineName('Debian'))
        expect(yield* state.keptWslDistro).toEqual(Option.some('Alpine'))
        yield* state.removeEngine(wslEngineName('Alpine'))
        yield* state.removeEngine(wslEngineName('Ubuntu'))
        expect(yield* state.keptWslDistro).toEqual(Option.none())
      }),
    ),
  )

  it.effect(
    'is, in a state written before it was named, the last known in WSL2',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('wsl-kept-last')
          const engines = [inWsl('Debian'), inWsl('Ubuntu'), server]
          yield* Effect.promise(() =>
            writeFile(
              NodePath.join(folder, stateFileName),
              JSON.stringify({ version: 1, engines, tokens: {} }),
            ),
          )
          const state = yield* makeAppState({ folder, secrets })
          expect(yield* state.engines).toEqual(engines)
          expect(yield* state.keptWslDistro).toEqual(Option.some('Ubuntu'))
        }),
      ),
  )
})
