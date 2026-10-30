import { Option, Schema } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  ProjectStatus,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// A project's trust on the Engines and projects screen (spec §18.4, §12.1, §20.2): each project's row
// says whether the user trusts it and offers to trust it or take the trust back, one change at a
// time, beside words saying what trusting it lets its own files do. The row shows the trust the
// engine's status stream sends; a refusal says so.

/** The projects, named with this machine's engine, which holds them. */
const project: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-1'),
}
const other: EngineProject = { ...project, project: ProjectId.make('p-2') }

describe('the trust in a project', () => {
  test('changed one project at a time; a failure says so', () => {
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.RequestedTrust({ project, trusted: true })),
      Command.expectExact(Engines.SetProjectTrust({ project, trusted: true })),
      model(shown => {
        expect(shown.trusting).toStrictEqual(Option.some(project))
      }),
      // Another change waits for this one.
      model(shown => {
        const another = Engines.update(
          shown,
          Engines.Message.RequestedTrust({ project: other, trusted: true }),
        )
        expect(another.model).toBe(shown)
        expect(another.commands).toBeUndefined()
      }),
      Command.resolve(
        Engines.SetProjectTrust,
        Engines.Message.SucceededTrust({ project }),
      ),
      model(shown => {
        expect(shown.trusting).toStrictEqual(Option.none())
        expect(shown.trustProblem).toStrictEqual(Option.none())
      }),
      message(Engines.Message.RequestedTrust({ project, trusted: false })),
      Command.expectExact(Engines.SetProjectTrust({ project, trusted: false })),
      Command.resolve(
        Engines.SetProjectTrust,
        Engines.Message.FailedTrust({
          project,
          reason: 'the engine has no project p-1',
        }),
      ),
      model(shown => {
        expect(shown.trusting).toStrictEqual(Option.none())
        expect(shown.trustProblem).toStrictEqual(
          Option.some({
            engine: localEngineName,
            text: "Couldn't change the trust in p-1: the engine has no project p-1",
          }),
        )
      }),
    )
  })
})

const flags = { platform: 'darwin' as const, release: '0.0.0' }

const engine = EngineId.make('e-1')

const row = (trusted: boolean) =>
  Schema.decodeUnknownSync(ProjectStatus)({
    project: 'p-1',
    name: 'fabrica',
    base: 'main',
    setUp: true,
    trusted,
    run: { _tag: 'idle' },
    ready: 0,
  })

/** The app on the Engines screen, its local engine's one project as `trusted` says. */
const onScreen = (trusted: boolean): Model => {
  const connected: Model = {
    ...initialModel(flags),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  }
  const withProject = update(
    connected,
    Message.ReceivedProjects({
      engine,
      name: 'local',
      items: [
        {
          _tag: 'snapshot',
          epoch: StreamEpoch.make('epoch-1'),
          seq: 0,
          value: [row(trusted)],
        },
      ],
    }),
  ).model
  return { ...withProject, screen: Screen.Engines() }
}

describe('the trust on the screen', () => {
  const projects = role('region', { name: 'Projects on local' })

  test('an untrusted project is trusted from its row, the words saying what that lets its files do', () => {
    scene(
      { update, view },
      givenScene(onScreen(false)),
      expectScene(within(projects, text('Untrusted'))).toExist(),
      expectScene(within(projects, text(Engines.trustWords))).toExist(),
      expectScene(role('button', { name: 'Trust fabrica' })).toHaveAttr(
        'aria-describedby',
        'project-trust-words-local',
      ),
      click(role('button', { name: 'Trust fabrica' })),
      SceneCommand.expectExact(
        Engines.SetProjectTrust({ project, trusted: true }),
      ),
      expectScene(role('button', { name: 'Trust fabrica' })).toBeDisabled(),
      expectScene(role('button', { name: 'Trust fabrica' })).toHaveText(
        'Changing…',
      ),
      SceneCommand.resolve(
        Engines.SetProjectTrust,
        Engines.Message.SucceededTrust({ project }),
      ),
      expectScene(role('button', { name: 'Trust fabrica' })).toBeEnabled(),
    )
  })

  test('a trusted project says so, and its trust is taken back from its row; a failure is shown', () => {
    scene(
      { update, view },
      givenScene(onScreen(true)),
      expectScene(within(projects, text('Trusted'))).toExist(),
      expectScene(role('button', { name: 'Stop trusting fabrica' })).toHaveText(
        'Untrust',
      ),
      click(role('button', { name: 'Stop trusting fabrica' })),
      SceneCommand.expectExact(
        Engines.SetProjectTrust({ project, trusted: false }),
      ),
      SceneCommand.resolve(
        Engines.SetProjectTrust,
        Engines.Message.FailedTrust({ project, reason: 'the engine stopped' }),
      ),
      expectScene(role('alert')).toHaveText(
        "Couldn't change the trust in p-1: the engine stopped",
      ),
    )
  })
})
