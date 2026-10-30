import { Option } from 'effect'
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
} from '@fabrica/client'
import { ProtocolVersion } from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// Installing and updating engines from the Engines screen (spec §9.2, §8.4): Add engine takes an SSH
// destination and has the app check the host, then shows what the check found and proposes; nothing is
// installed until the user agrees, and only what they agreed to. An engine that refused the app at
// connect is offered its update on this machine the same way, and the connection is tried again once
// it is updated; an app too old for its engine is told to update itself.

const server = EngineHost.cases.Ssh.make({ destination: 'me@build-box' })
const local = EngineHost.cases.Local.make({})

const checkOf = (plan: InstallPlan): HostCheck => ({
  host: 'Linux x86_64, glibc 2.39',
  target: 'linux-x64',
  plan,
  notes: [],
})

const fresh = checkOf(InstallPlan.cases.Install.make({ to: '0.2.0' }))
const older = checkOf(
  InstallPlan.cases.Update.make({ from: '0.1.0', to: '0.2.0' }),
)

const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '0.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/0.2.0/bin/fabrica',
    service:
      'installed the systemd user unit fabrica.service: /home/me/.config/systemd/user/fabrica.service',
  },
})

const stepOf = (shown: Engines.Model): Engines.SetupStep =>
  Engines.EngineSetup.match(shown.engineSetup, {
    Running: ({ step }) => step,
    Closed: () => expect.unreachable('the setup is closed'),
    Editing: () => expect.unreachable('the setup is being typed'),
    Wsl: () => expect.unreachable('a WSL2 distribution is being found'),
  })

describe('Add engine', () => {
  test('checks the host, then installs only once the user agrees', () => {
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.OpenedAddEngine()),
      message(Engines.Message.ChangedEngineDestination({ destination: ' ' })),
      message(Engines.Message.SubmittedAddEngine()),
      Command.expectNone(),
      model(shown => {
        expect(shown.engineSetup).toEqual(
          Engines.EngineSetup.Editing({
            destination: ' ',
            problem: Option.some(
              'Give the host’s SSH destination: user@host, or a host of your ~/.ssh/config.',
            ),
          }),
        )
      }),
      message(
        Engines.Message.ChangedEngineDestination({
          destination: ' me@build-box ',
        }),
      ),
      message(Engines.Message.SubmittedAddEngine()),
      Command.resolve(
        Engines.CheckEngine({ host: server }),
        Engines.Message.CompletedEngineCheck({
          host: server,
          answer: CheckAnswer.cases.Checked.make({ check: fresh }),
        }),
      ),
      model(shown => {
        expect(stepOf(shown)).toEqual(
          Engines.SetupStep.Checked({ check: fresh }),
        )
      }),
      message(Engines.Message.ConsentedInstall()),
      Command.resolve(
        Engines.InstallEngine({
          host: server,
          consent: InstallConsent.cases.Install.make({ to: '0.2.0' }),
        }),
        Engines.Message.CompletedEngineInstall({
          host: server,
          answer: installed,
        }),
      ),
      model(shown => {
        expect(stepOf(shown)).toEqual(
          Engines.SetupStep.Installed({ installed: installed.installed }),
        )
      }),
      message(Engines.Message.ClosedEngineSetup()),
      model(shown => {
        expect(shown.engineSetup).toEqual(Engines.EngineSetup.Closed())
      }),
    )
  })

  test('an older engine there is updated with the user’s consent to that update', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        engineSetup: Engines.EngineSetup.Running({
          host: server,
          step: Engines.SetupStep.Checked({ check: older }),
        }),
      }),
      message(Engines.Message.ConsentedInstall()),
      Command.expectExact(
        Engines.InstallEngine({
          host: server,
          consent: InstallConsent.cases.Update.make({
            from: '0.1.0',
            to: '0.2.0',
          }),
        }),
      ),
      model(shown => {
        // An install under way is never interrupted, nor started again.
        expect(
          Engines.update(shown, Engines.Message.ClosedEngineSetup()).model,
        ).toBe(shown)
        expect(
          Engines.update(shown, Engines.Message.ConsentedInstall()).commands,
        ).toBeUndefined()
      }),
      Command.resolve(
        Engines.InstallEngine,
        Engines.Message.CompletedEngineInstall({
          host: server,
          answer: InstallAnswer.cases.Failed.make({
            reason: "the host's engine changed since it was checked",
          }),
        }),
      ),
      model(shown => {
        expect(stepOf(shown)).toEqual(
          Engines.SetupStep.Failed({
            reason: "the host's engine changed since it was checked",
          }),
        )
      }),
      message(Engines.Message.RetriedEngineCheck()),
      Command.resolve(
        Engines.CheckEngine({ host: server }),
        Engines.Message.CompletedEngineCheck({
          host: server,
          answer: CheckAnswer.cases.Checked.make({ check: older }),
        }),
      ),
      model(shown => {
        expect(stepOf(shown)).toEqual(
          Engines.SetupStep.Checked({ check: older }),
        )
      }),
    )
  })

  test('a host that has the engine, or a later one, is offered nothing to install', () => {
    for (const plan of [
      InstallPlan.cases.Current.make({ version: '0.2.0' }),
      InstallPlan.cases.Newer.make({ there: '0.3.0', offered: '0.2.0' }),
    ]) {
      story(
        Engines.update,
        given({
          ...Engines.init(),
          engineSetup: Engines.EngineSetup.Running({
            host: server,
            step: Engines.SetupStep.Checked({ check: checkOf(plan) }),
          }),
        }),
        message(Engines.Message.ConsentedInstall()),
        Command.expectNone(),
      )
    }
  })

  test('an answer for another host than the one checked is left alone', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        engineSetup: Engines.EngineSetup.Running({
          host: server,
          step: Engines.SetupStep.Checking(),
        }),
      }),
      message(
        Engines.Message.CompletedEngineCheck({
          host: local,
          answer: CheckAnswer.cases.Checked.make({ check: fresh }),
        }),
      ),
      model(shown => {
        expect(stepOf(shown)).toEqual(Engines.SetupStep.Checking())
      }),
    )
  })

  test('from the screen, as the user types and clicks', () => {
    const flags = { platform: 'darwin' as const, release: '0.0.0' }
    scene(
      { update, view },
      givenScene({ ...initialModel(flags), screen: Screen.Engines() }),
      click(role('button', { name: '+ Add engine' })),
      type(label('SSH destination'), 'me@build-box'),
      click(role('button', { name: 'Check the host' })),
      SceneCommand.expectExact(Engines.CheckEngine({ host: server })),
      expectScene(
        within(
          role('region', { name: 'Engine on me@build-box' }),
          role('status'),
        ),
      ).toHaveText('Checking me@build-box…'),
      SceneCommand.resolve(
        Engines.CheckEngine,
        Engines.Message.CompletedEngineCheck({
          host: server,
          answer: CheckAnswer.cases.Checked.make({ check: older }),
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine on me@build-box' }),
          text(/fabrica 0\.1\.0 is there\. Update it to 0\.2\.0\?/u),
        ),
      ).toExist(),
      click(role('button', { name: 'Update to 0.2.0' })),
      SceneCommand.expectExact(
        Engines.InstallEngine({
          host: server,
          consent: InstallConsent.cases.Update.make({
            from: '0.1.0',
            to: '0.2.0',
          }),
        }),
      ),
      SceneCommand.resolve(
        Engines.InstallEngine,
        Engines.Message.CompletedEngineInstall({
          host: server,
          answer: installed,
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine on me@build-box' }),
          text(/Installed fabrica 0\.2\.0 on me@build-box/u),
        ),
      ).toExist(),
    )
  })
})

describe('the update offered at connect', () => {
  const flags = { platform: 'darwin' as const, release: '0.2.0' }
  const refused = (update: 'client' | 'engine'): Model => ({
    ...initialModel(flags),
    screen: Screen.Engines(),
    connection: Connection.Refused({
      client: ProtocolVersion.make(2),
      engine: ProtocolVersion.make(update === 'engine' ? 1 : 3),
      update,
    }),
  })

  test('an engine too old for the app is updated on this machine, and the connection tried again', () => {
    const before = refused('engine')
    scene(
      { update, view },
      givenScene(before),
      click(role('button', { name: 'Update the engine' })),
      SceneCommand.expectExact(Engines.CheckEngine({ host: local })),
      SceneCommand.resolve(
        Engines.CheckEngine,
        Engines.Message.CompletedEngineCheck({
          host: local,
          answer: CheckAnswer.cases.Checked.make({ check: older }),
        }),
      ),
      click(role('button', { name: 'Update to 0.2.0' })),
      SceneCommand.resolve(
        Engines.InstallEngine({
          host: local,
          consent: InstallConsent.cases.Update.make({
            from: '0.1.0',
            to: '0.2.0',
          }),
        }),
        Engines.Message.CompletedEngineInstall({
          host: local,
          answer: installed,
        }),
      ),
      expectScene(
        within(
          role('region', { name: 'Engine on this machine' }),
          text(/Installed fabrica 0\.2\.0 on this machine/u),
        ),
      ).toExist(),
      expectScene(
        within(role('article', { name: 'Engine local' }), text('Connecting')),
      ).toExist(),
    )
    // Another host's engine installed leaves the refusal as it was.
    const elsewhere = update(
      before,
      Message.GotEnginesMessage({
        message: Engines.Message.CompletedEngineInstall({
          host: server,
          answer: installed,
        }),
      }),
    ).model
    expect(elsewhere.connection).toEqual(before.connection)
    expect(elsewhere.attempt).toBe(before.attempt)
  })

  test('an app too old for its engine is told to update itself, and offered no engine update', () => {
    scene(
      { update, view },
      givenScene(refused('client')),
      expectScene(
        within(
          role('article', { name: 'Engine local' }),
          text(/newer than this app's 2: update the app/u),
        ),
      ).toExist(),
      expectScene(role('button', { name: 'Update the engine' })).toBeAbsent(),
    )
  })
})
