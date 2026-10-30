import { Effect, Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  CheckAnswer,
  EngineHost,
  type HostCheck,
  InstallPlan,
  KeepAnswer,
  checkedDistro,
  wslEngineName,
} from '@fabrica/client'
import { EngineId } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { ConnectionTarget } from '../src/connection/target'
import { keepEngineIn } from '../src/main/known-engines'
import {
  EngineAddress,
  KnownEngine,
  type SecretBox,
  makeAppState,
} from '../src/main/state'
import { launchDistro } from '../src/main/wsl'

// The engine Add engine installs in WSL2, or finds up to date there, kept among the known engines (spec
// §7.6, §9.1): main reaches one found up to date as it does one installed, and the page keeps it, at
// its first hello, under its distribution's name; the next start finds it in the app's state and
// reaches it where this machine runs no engine.

const ubuntu = EngineHost.cases.Wsl.make({ distro: 'Ubuntu' })

const checked = (plan: InstallPlan): CheckAnswer =>
  CheckAnswer.cases.Checked.make({
    check: {
      host: 'Linux x86_64, glibc 2.39',
      target: 'linux-x64',
      plan,
      notes: [],
    } satisfies HostCheck,
  })

/** A stand-in for safeStorage, which the known engines never reach. */
const secrets: SecretBox = {
  unavailable: () => Option.none(),
  encrypt: text => Buffer.from(text),
  decrypt: bytes => Buffer.from(bytes).toString('utf8'),
}

describe('the engine Add engine finds up to date in WSL2', () => {
  it('is the one main reaches, and no other host’s or plan’s', () => {
    const current = checked(
      InstallPlan.cases.Current.make({ version: '0.2.0' }),
    )
    expect(checkedDistro({ host: ubuntu, answer: current })).toEqual(
      Option.some('Ubuntu'),
    )
    expect(
      checkedDistro({
        host: EngineHost.cases.Ssh.make({ destination: 'me@server-1' }),
        answer: current,
      }),
    ).toEqual(Option.none())
    expect(
      checkedDistro({
        host: ubuntu,
        answer: checked(InstallPlan.cases.Install.make({ to: '0.2.0' })),
      }),
    ).toEqual(Option.none())
    expect(
      checkedDistro({
        host: ubuntu,
        answer: checked(
          InstallPlan.cases.Update.make({ from: '0.1.0', to: '0.2.0' }),
        ),
      }),
    ).toEqual(Option.none())
    expect(
      checkedDistro({
        host: ubuntu,
        answer: CheckAnswer.cases.Failed.make({ reason: 'wsl.exe went away' }),
      }),
    ).toEqual(Option.none())
  })
})

describe('the engine in WSL2 kept among the known engines', () => {
  it.effect('is reached at the next start, where this machine runs none', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('wsl-known-engine')
        const state = yield* makeAppState({ folder, secrets })
        const engine = KnownEngine.make({
          name: wslEngineName('Ubuntu'),
          address: EngineAddress.cases.Wsl.make({ distro: 'Ubuntu' }),
          engine: EngineId.make('e-wsl-ubuntu'),
          protocol: 1,
        })
        expect(yield* keepEngineIn(state, engine)).toEqual(
          KeepAnswer.cases.Kept.make({}),
        )
        // Kept again once updated there: the one of its name is replaced.
        const updated = KnownEngine.make({ ...engine, protocol: 2 })
        expect(yield* keepEngineIn(state, updated)).toEqual(
          KeepAnswer.cases.Kept.make({}),
        )
        const restarted = yield* makeAppState({ folder, secrets })
        expect(yield* restarted.engines).toEqual([updated])
        expect(
          launchDistro({
            local: ConnectionTarget.cases.Unavailable.make({
              reason: 'no local engine on Windows',
            }),
            kept: yield* restarted.keptWslDistro,
          }),
        ).toEqual(Option.some('Ubuntu'))
      }),
    ),
  )
})
