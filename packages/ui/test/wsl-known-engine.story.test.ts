import { Option } from 'effect'

import { describe, expect, test } from '@effect/vitest'
import {
  CheckAnswer,
  EngineAddress,
  EngineHost,
  type HostCheck,
  InstallAnswer,
  InstallPlan,
  KnownEngine,
  KnownEnginesAnswer,
  wslEngineName,
} from '@fabrica/client'
import { EngineId, protocolVersion } from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import * as RemoteEngines from '../src/app/remote-engines'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import * as Engines from '../src/screens/engines'

// The engine Add engine installs in WSL2, or finds up to date there, kept among the known engines (spec
// §7.6, §9.1): main reaches it as the app's own connection, and that connection's next hello keeps it
// under its distribution's name, with the engine's ID and protocol, so main reaches it again at the next
// start. An install elsewhere, or one that failed, keeps nothing.

const ubuntu = EngineHost.cases.Wsl.make({ distro: 'Ubuntu' })
const wslEngine = EngineId.make('e-wsl-ubuntu')

const checkOf = (plan: InstallPlan): HostCheck => ({
  host: 'Linux x86_64, glibc 2.39',
  target: 'linux-x64',
  plan,
  notes: [],
})

const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '0.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/0.2.0/bin/fabrica',
    service: 'installed the systemd user unit fabrica.service',
  },
})

const stopped: Model = {
  ...initialModel({ platform: 'win32', release: '0.2.0' }),
  screen: Screen.Engines(),
  connection: Connection.Stopped({
    reason:
      'the WSL distribution Ubuntu has no fabrica on its PATH: install the engine there',
  }),
}

const engineMessage = (message: Engines.Message) =>
  Message.GotEnginesMessage({ message })

const hello = Message.ConnectedToEngine({
  engine: wslEngine,
  release: '0.2.0',
  protocol: protocolVersion,
})

const keptUbuntu = KnownEngine.make({
  name: 'WSL Ubuntu',
  address: EngineAddress.cases.Wsl.make({ distro: 'Ubuntu' }),
  engine: wslEngine,
  protocol: protocolVersion,
})

/** The engines the KeepEngine commands `model`'s update for `message` gives keep. */
const keeps = (model: Model, message: Message) => {
  const next = update(model, message)
  return {
    model: next.model,
    keeps: (next.commands ?? []).flatMap(command =>
      command.name === RemoteEngines.KeepEngine.name
        ? [command.args?.['engine']]
        : [],
    ),
  }
}

describe('the engine Add engine installs in WSL2', () => {
  test('is kept under its distribution’s name at the app’s connection’s next hello, once', () => {
    const after = update(
      stopped,
      engineMessage(
        Engines.Message.CompletedEngineInstall({
          host: ubuntu,
          answer: installed,
        }),
      ),
    ).model
    expect(after.connection).toEqual(Connection.Connecting())
    expect(after.remotes.wsl).toEqual(Option.some('Ubuntu'))
    const first = keeps(after, hello)
    expect(first.keeps).toEqual([keptUbuntu])
    expect(first.model.remotes.wsl).toEqual(Option.none())
    // The app's connection connected again, its engine kept already.
    expect(keeps(first.model, hello).keeps).toEqual([])
  })

  test('is kept when found up to date there, the app’s connection tried again for it', () => {
    const after = update(
      stopped,
      engineMessage(
        Engines.Message.CompletedEngineCheck({
          host: ubuntu,
          answer: CheckAnswer.cases.Checked.make({
            check: checkOf(
              InstallPlan.cases.Current.make({ version: '0.2.0' }),
            ),
          }),
        }),
      ),
    ).model
    expect(after.connection).toEqual(Connection.Connecting())
    expect(after.attempt).toBe(stopped.attempt + 1)
    expect(keeps(after, hello).keeps).toEqual([keptUbuntu])
  })

  test('waits for its hello as the known engines are read', () => {
    const reached = update(
      stopped,
      engineMessage(
        Engines.Message.CompletedEngineInstall({
          host: ubuntu,
          answer: installed,
        }),
      ),
    ).model
    const loaded = update(
      reached,
      Message.LoadedKnownEngines({
        answer: KnownEnginesAnswer.cases.Read.make({ engines: [] }),
      }),
    ).model
    expect(keeps(loaded, hello).keeps).toEqual([keptUbuntu])
  })

  test('is none where the install failed, the check found it to install or update, or the host isn’t WSL2', () => {
    const quiet = [
      Engines.Message.CompletedEngineInstall({
        host: ubuntu,
        answer: InstallAnswer.cases.Failed.make({ reason: 'no space left' }),
      }),
      Engines.Message.CompletedEngineInstall({
        host: EngineHost.cases.Ssh.make({ destination: 'me@build-box' }),
        answer: installed,
      }),
      Engines.Message.CompletedEngineInstall({
        host: EngineHost.cases.Local.make({}),
        answer: installed,
      }),
      Engines.Message.CompletedEngineCheck({
        host: ubuntu,
        answer: CheckAnswer.cases.Checked.make({
          check: checkOf(InstallPlan.cases.Install.make({ to: '0.2.0' })),
        }),
      }),
      Engines.Message.CompletedEngineCheck({
        host: ubuntu,
        answer: CheckAnswer.cases.Checked.make({
          check: checkOf(
            InstallPlan.cases.Newer.make({ there: '0.3.0', offered: '0.2.0' }),
          ),
        }),
      }),
      Engines.Message.CompletedEngineCheck({
        host: EngineHost.cases.Ssh.make({ destination: 'me@build-box' }),
        answer: CheckAnswer.cases.Checked.make({
          check: checkOf(InstallPlan.cases.Current.make({ version: '0.2.0' })),
        }),
      }),
    ]
    for (const message of quiet) {
      expect(Engines.reachedInWslAfter(message)).toEqual(Option.none())
      const after = update(stopped, engineMessage(message)).model
      expect(keeps(after, hello).keeps).toEqual([])
    }
    // This machine's engine installed is still tried again, and its hello keeps nothing.
    expect(
      Engines.reconnectsAfter(
        Engines.Message.CompletedEngineInstall({
          host: EngineHost.cases.Local.make({}),
          answer: installed,
        }),
      ),
    ).toBe(true)
  })

  test('is named after its distribution', () => {
    expect(wslEngineName('Ubuntu-24.04')).toBe('WSL Ubuntu-24.04')
  })
})
