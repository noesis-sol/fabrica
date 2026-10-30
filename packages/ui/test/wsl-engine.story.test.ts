import { Effect, Option } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  label,
  role,
  scene,
  text,
  type,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  CheckAnswer,
  EngineHost,
  type HostCheck,
  InstallAnswer,
  InstallConsent,
  InstallPlan,
  UbuntuInstall,
  WslSearch,
} from '@fabrica/client'
import { EngineId, ProjectId, ProjectInfo } from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { appHostOf } from '../src/app/host'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// Adding an engine in WSL2 from the Windows app (spec §7.6, H31): Add engine offers "In WSL2" beside
// SSH on Windows only; the distribution the app found is checked and the engine installed there as on
// any host, Ubuntu offered where there is none, and why WSL can't run said where it can't; the
// connection is tried again once the engine is installed there. A project's checkout on a Windows drive,
// under `/mnt/<letter>`, is warned about as it is added.

const ubuntu = EngineHost.cases.Wsl.make({ distro: 'Ubuntu' })
const found = WslSearch.cases.Found.make({ distro: 'Ubuntu' })

const fresh: HostCheck = {
  host: 'Linux x86_64, glibc 2.39',
  target: 'linux-x64',
  plan: InstallPlan.cases.Install.make({ to: '0.2.0' }),
  notes: [],
}

const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '0.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/0.2.0/bin/fabrica',
    service:
      "systemd isn't running here, so no login service is installed: the engine starts when the app connects",
  },
})

const onWindows = (): Model => ({
  ...initialModel({ platform: 'win32', release: '0.2.0' }),
  screen: Screen.Engines(),
})

const searching = {
  ...Engines.init(),
  engineSetup: Engines.EngineSetup.Wsl({ step: Engines.WslStep.Searching() }),
}

describe('Add engine in WSL2', () => {
  test('on Windows, checks the distribution found and installs the engine there once the user agrees', () => {
    scene(
      { update, view },
      givenScene(onWindows()),
      click(role('button', { name: '+ Add engine' })),
      expectScene(
        role('button', { name: 'Over SSH', pressed: true }),
      ).toExist(),
      click(role('button', { name: 'In WSL2' })),
      SceneCommand.expectExact(Engines.FindWsl()),
      expectScene(
        within(role('region', { name: 'Engine in WSL2' }), role('status')),
      ).toHaveText('Looking for a WSL2 distribution…'),
      SceneCommand.resolve(
        Engines.FindWsl,
        Engines.Message.CompletedWslSearch({ search: found }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine in WSL2' }),
          text(/The engine runs in Ubuntu/u),
        ),
      ).toExist(),
      click(role('button', { name: 'Check Ubuntu' })),
      SceneCommand.expectExact(Engines.CheckEngine({ host: ubuntu })),
      expectScene(
        within(
          role('region', { name: 'Engine on WSL Ubuntu' }),
          role('status'),
        ),
      ).toHaveText('Checking WSL Ubuntu…'),
      SceneCommand.resolve(
        Engines.CheckEngine,
        Engines.Message.CompletedEngineCheck({
          host: ubuntu,
          answer: CheckAnswer.cases.Checked.make({ check: fresh }),
        }),
      ),
      click(role('button', { name: 'Install 0.2.0' })),
      SceneCommand.expectExact(
        Engines.InstallEngine({
          host: ubuntu,
          consent: InstallConsent.cases.Install.make({ to: '0.2.0' }),
        }),
      ),
      SceneCommand.resolve(
        Engines.InstallEngine,
        Engines.Message.CompletedEngineInstall({
          host: ubuntu,
          answer: installed,
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine on WSL Ubuntu' }),
          text(/Installed fabrica 0\.2\.0 on WSL Ubuntu/u),
        ),
      ).toExist(),
    )
  })

  test('is offered only on Windows', () => {
    scene(
      { update, view },
      givenScene({
        ...initialModel({ platform: 'darwin', release: '0.2.0' }),
        screen: Screen.Engines(),
      }),
      click(role('button', { name: '+ Add engine' })),
      expectScene(role('form', { name: 'Add engine' })).toExist(),
      expectScene(role('button', { name: 'In WSL2' })).toBeAbsent(),
    )
  })

  test('offers Ubuntu where there is no WSL2 distribution, and checks it once installed', () => {
    story(
      Engines.update,
      given(searching),
      message(
        Engines.Message.CompletedWslSearch({
          search: WslSearch.cases.None.make({ wsl1: ['Legacy'] }),
        }),
      ),
      message(Engines.Message.RequestedUbuntuInstall()),
      Command.resolve(
        Engines.InstallUbuntu(),
        Engines.Message.CompletedUbuntuInstall({
          outcome: UbuntuInstall.cases.Ready.make({ distro: 'Ubuntu' }),
        }),
      ),
      model(shown => {
        expect(shown.engineSetup).toEqual(
          Engines.EngineSetup.Wsl({
            step: Engines.WslStep.Searched({ search: found }),
          }),
        )
      }),
      message(Engines.Message.RequestedWslCheck()),
      Command.resolve(
        Engines.CheckEngine({ host: ubuntu }),
        Engines.Message.CompletedEngineCheck({
          host: ubuntu,
          answer: CheckAnswer.cases.Checked.make({ check: fresh }),
        }),
      ),
      model(shown => {
        expect(shown.engineSetup).toEqual(
          Engines.EngineSetup.Running({
            host: ubuntu,
            name: Option.none(),
            step: Engines.SetupStep.Checked({ check: fresh }),
          }),
        )
      }),
    )
  })

  test('says why Ubuntu isn’t ready, and looks again when asked', () => {
    const reason =
      'WSL installed, but Ubuntu is not ready yet: restart Windows if WSL asked to, open Ubuntu once to set up its user, then try again'
    story(
      Engines.update,
      given({
        ...Engines.init(),
        engineSetup: Engines.EngineSetup.Wsl({
          step: Engines.WslStep.InstallingUbuntu(),
        }),
      }),
      // Nothing interrupts the install: closing waits for it.
      message(Engines.Message.ClosedEngineSetup()),
      message(Engines.Message.ChoseWslEngine()),
      Command.expectNone(),
      message(
        Engines.Message.CompletedUbuntuInstall({
          outcome: UbuntuInstall.cases.Unfinished.make({ reason }),
        }),
      ),
      model(shown => {
        expect(shown.engineSetup).toEqual(
          Engines.EngineSetup.Wsl({
            step: Engines.WslStep.UbuntuUnfinished({ reason }),
          }),
        )
      }),
      message(Engines.Message.ChoseWslEngine()),
      Command.resolve(
        Engines.FindWsl(),
        Engines.Message.CompletedWslSearch({ search: found }),
      ),
    )
    scene(
      { update, view },
      givenScene({
        ...onWindows(),
        screens: {
          ...onWindows().screens,
          engines: {
            ...Engines.init(),
            engineSetup: Engines.EngineSetup.Wsl({
              step: Engines.WslStep.UbuntuUnfinished({ reason }),
            }),
          },
        },
      }),
      expectScene(
        within(role('region', { name: 'Engine in WSL2' }), text(reason)),
      ).toExist(),
      click(role('button', { name: 'Look again' })),
      SceneCommand.resolve(
        Engines.FindWsl,
        Engines.Message.CompletedWslSearch({ search: found }),
      ),
      expectScene(role('button', { name: 'Check Ubuntu' })).toExist(),
    )
  })

  test('says why where WSL can’t run, and leaves answers that come too late alone', () => {
    const unavailable = WslSearch.cases.Unavailable.make({
      reason: "couldn't run wsl.exe: spawn wsl.exe ENOENT",
    })
    scene(
      { update, view },
      givenScene(onWindows()),
      click(role('button', { name: '+ Add engine' })),
      click(role('button', { name: 'In WSL2' })),
      SceneCommand.resolve(
        Engines.FindWsl,
        Engines.Message.CompletedWslSearch({ search: unavailable }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine in WSL2' }),
          text(/WSL can’t run here: couldn't run wsl\.exe/u),
        ),
      ).toExist(),
      click(role('button', { name: 'Over SSH' })),
      expectScene(label('SSH destination')).toExist(),
    )
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.ChoseWslEngine()),
      message(Engines.Message.CompletedWslSearch({ search: found })),
      message(Engines.Message.RequestedUbuntuInstall()),
      message(Engines.Message.RequestedWslCheck()),
      Command.expectNone(),
      model(shown => {
        expect(shown.engineSetup).toEqual(Engines.EngineSetup.Closed())
      }),
    )
  })

  test('tries the connection again once the engine is installed in WSL2', () => {
    const stopped: Model = {
      ...onWindows(),
      connection: Connection.Stopped({
        reason:
          'the WSL distribution Ubuntu has no fabrica on its PATH: install the engine there',
      }),
    }
    const after = update(
      stopped,
      Message.GotEnginesMessage({
        message: Engines.Message.CompletedEngineInstall({
          host: ubuntu,
          answer: installed,
        }),
      }),
    ).model
    expect(after.connection).toEqual(Connection.Connecting())
    expect(after.attempt).toBe(stopped.attempt + 1)
  })
})

describe('a checkout on a Windows drive', () => {
  test('is warned about as the project is added, and once it is', () => {
    const warning =
      "/mnt/c/Users/me/app is on the Windows drive C:, where git is slow and POSIX file semantics don't hold: clone the project into the distribution's own file system, such as under ~/"
    scene(
      { update, view },
      givenScene({
        ...onWindows(),
        connection: Connection.Up({
          engine: EngineId.make('engine-1'),
          release: '0.2.0',
          protocol: 1,
        }),
      }),
      click(role('button', { name: '+ Add project' })),
      type(label('Its folder on local'), '/home/me/app'),
      expectScene(text(/Windows drive/u)).toBeAbsent(),
      type(label('Its folder on local'), '/mnt/c/Users/me/app'),
      expectScene(
        within(role('form', { name: 'Add project' }), text(warning)),
      ).toExist(),
      click(role('button', { name: 'Add' })),
      SceneCommand.resolve(
        Engines.AddProject,
        Engines.Message.SucceededAddProject({
          engine: localEngineName,
          project: ProjectInfo.make({
            id: ProjectId.make('p-3'),
            name: 'app',
            path: '/mnt/c/Users/me/app',
            origin: 'registered',
            url: Option.none(),
            base: 'main',
            setUp: true,
            trusted: false,
          }),
        }),
      ),
      expectScene(
        within(role('status', { name: 'Added project' }), text(warning)),
      ).toExist(),
    )
  })
})

describe('the app’s WSL2 search and Ubuntu install', () => {
  test('are the preload’s, decoded, a failure in words; none where no app is around', async () => {
    const host = appHostOf({
      fabrica: {
        findWsl: () => Promise.resolve({ _tag: 'Found', distro: 'Ubuntu' }),
        installUbuntu: () => Promise.reject(new Error('main went away')),
      },
    })
    const search = await Effect.runPromise(Option.getOrThrow(host.findWsl))
    expect(search).toEqual(found)
    const install = await Effect.runPromise(
      Option.getOrThrow(host.installUbuntu),
    )
    expect(install).toEqual(
      UbuntuInstall.cases.Unfinished.make({ reason: 'main went away' }),
    )
    const odd = appHostOf({
      fabrica: {
        findWsl: () => Promise.resolve({ _tag: 'Found', distro: '--exec' }),
      },
    })
    expect(
      WslSearch.guards.Unavailable(
        await Effect.runPromise(Option.getOrThrow(odd.findWsl)),
      ),
    ).toBe(true)
    expect(Option.isNone(odd.installUbuntu)).toBe(true)
    expect(Option.isNone(appHostOf({}).findWsl)).toBe(true)
  })
})
