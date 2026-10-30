import { Option } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  label,
  role,
  scene,
  type,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  FolderListing,
  HostFolder,
  ProjectSource,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// Browsing the engine host's folders for the checkout to add (spec §10.1, §18.4): the add-project
// form's Browse… asks the engine for the folder typed, or its home folder where none is; a folder's
// subfolders open by name, its checkouts marked and chosen with a button, which puts the path in the
// form and closes the browser. Only the answer to the folder last asked is shown; a folder the engine
// can't list says why, and Home starts again. Cancelling or adding closes the browser.

const home = FolderListing.make({
  path: '/Users/me',
  parent: Option.some('/Users'),
  checkout: false,
  folders: [
    HostFolder.make({
      name: 'notes',
      path: '/Users/me/notes',
      checkout: false,
    }),
    HostFolder.make({ name: 'src', path: '/Users/me/src', checkout: false }),
  ],
})

const src = FolderListing.make({
  path: '/Users/me/src',
  parent: Option.some('/Users/me'),
  checkout: false,
  folders: [
    HostFolder.make({ name: 'app', path: '/Users/me/src/app', checkout: true }),
    HostFolder.make({
      name: 'old',
      path: '/Users/me/src/old',
      checkout: false,
    }),
  ],
})

const opened = Engines.openAddProject(Engines.init(), localEngineName)

const formPath = (shown: Engines.Model): string =>
  Engines.AddFlow.match(shown.addProject, {
    Closed: () => expect.unreachable('the form is closed'),
    Editing: ({ form }) => form.path,
    Adding: ({ form }) => form.path,
  })

describe('browsing the engine host’s folders', () => {
  test('from the home folder into a subfolder, choosing a checkout for the form', () => {
    story(
      Engines.update,
      given(opened),
      message(Engines.Message.OpenedFolders()),
      Command.expectExact(
        Engines.LoadFolders({ engine: localEngineName, path: Option.none() }),
      ),
      model(shown => {
        expect(shown.folders).toEqual(
          Engines.FolderBrowser.Loading({
            engine: localEngineName,
            path: Option.none(),
          }),
        )
      }),
      Command.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.none(),
          listing: home,
        }),
      ),
      model(shown => {
        expect(shown.folders).toEqual(
          Engines.FolderBrowser.Shown({ listing: home }),
        )
      }),
      message(
        Engines.Message.RequestedFolders({
          path: Option.some('/Users/me/src'),
        }),
      ),
      Command.expectExact(
        Engines.LoadFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/src'),
        }),
      ),
      Command.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/src'),
          listing: src,
        }),
      ),
      message(Engines.Message.ChoseFolder({ path: '/Users/me/src/app' })),
      model(shown => {
        expect(formPath(shown)).toBe('/Users/me/src/app')
        expect(shown.folders).toEqual(Engines.FolderBrowser.Closed())
      }),
      message(Engines.Message.SubmittedAddProject()),
      Command.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.path.make({ path: '/Users/me/src/app' }),
          name: Option.none(),
        }),
      ),
      Command.resolve(
        Engines.AddProject,
        Engines.Message.FailedAddProject({ reason: 'it has no commits' }),
      ),
    )
  })

  test('from the path typed; a folder the engine can’t list says why, and Home starts again', () => {
    story(
      Engines.update,
      given(opened),
      message(Engines.Message.ChangedProjectPath({ path: ' /Users/me/gone ' })),
      message(Engines.Message.OpenedFolders()),
      Command.expectExact(
        Engines.LoadFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/gone'),
        }),
      ),
      Command.resolve(
        Engines.LoadFolders,
        Engines.Message.FailedFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/gone'),
          reason: 'there is no folder at /Users/me/gone',
        }),
      ),
      model(shown => {
        expect(shown.folders).toEqual(
          Engines.FolderBrowser.Failed({
            path: Option.some('/Users/me/gone'),
            reason: 'there is no folder at /Users/me/gone',
          }),
        )
        expect(formPath(shown)).toBe(' /Users/me/gone ')
      }),
      message(Engines.Message.RequestedFolders({ path: Option.none() })),
      Command.expectExact(
        Engines.LoadFolders({ engine: localEngineName, path: Option.none() }),
      ),
      Command.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.none(),
          listing: home,
        }),
      ),
      model(shown => {
        expect(shown.folders).toEqual(
          Engines.FolderBrowser.Shown({ listing: home }),
        )
      }),
    )
  })

  test('only the answer to the folder last asked is shown', () => {
    const asked = Engines.update(
      Engines.update(opened, Engines.Message.OpenedFolders()).model,
      Engines.Message.RequestedFolders({ path: Option.some('/Users/me/src') }),
    ).model
    const late = Engines.update(
      asked,
      Engines.Message.SucceededFolders({
        engine: localEngineName,
        path: Option.none(),
        listing: home,
      }),
    )
    expect(late.model).toBe(asked)
    const closed = Engines.update(asked, Engines.Message.ClosedFolders()).model
    const afterClose = Engines.update(
      closed,
      Engines.Message.SucceededFolders({
        engine: localEngineName,
        path: Option.some('/Users/me/src'),
        listing: src,
      }),
    )
    expect(afterClose.model.folders).toEqual(Engines.FolderBrowser.Closed())
  })

  test('nothing is browsed while the form is closed, sent, or for a git URL; cancelling closes the browser', () => {
    const closed = Engines.update(
      Engines.init(),
      Engines.Message.RequestedFolders({ path: Option.none() }),
    )
    expect(closed.model.folders).toEqual(Engines.FolderBrowser.Closed())
    expect(closed.commands).toBeUndefined()

    const forUrl = Engines.update(
      Engines.update(opened, Engines.Message.ChoseSource({ kind: 'url' }))
        .model,
      Engines.Message.OpenedFolders(),
    )
    expect(forUrl.model.folders).toEqual(Engines.FolderBrowser.Closed())
    expect(forUrl.commands).toBeUndefined()

    story(
      Engines.update,
      given(opened),
      message(Engines.Message.OpenedFolders()),
      Command.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.none(),
          listing: home,
        }),
      ),
      message(Engines.Message.CancelledAddProject()),
      model(shown => {
        expect(shown.addProject).toEqual(Engines.AddFlow.Closed())
        expect(shown.folders).toEqual(Engines.FolderBrowser.Closed())
      }),
    )
  })
})

const flags = { platform: 'darwin' as const, release: '0.0.0' }

const onScreen: Model = (() => {
  const connected = initialModel(flags)
  return {
    ...connected,
    connection: Connection.Up({
      engine: EngineId.make('e-1'),
      release: '0.1.0',
      protocol: protocolVersion,
    }),
    screen: Screen.Engines(),
    screens: {
      ...connected.screens,
      engines: Engines.openAddProject(
        connected.screens.engines,
        localEngineName,
      ),
    },
  }
})()

describe('the folder browser on the screen', () => {
  test('Browse… beside the path, a checkout chosen from a subfolder, then added', () => {
    scene(
      { update, view },
      givenScene(onScreen),
      click(role('button', { name: 'Browse…' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({ engine: localEngineName, path: Option.none() }),
      ),
      expectScene(
        within(role('region', { name: 'Folders on local' }), role('status')),
      ).toHaveText('Listing the folders…'),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.none(),
          listing: home,
        }),
      ),
      expectScene(role('list', { name: 'Folders in /Users/me' })).toExist(),
      expectScene(role('button', { name: 'Up' })).toExist(),
      click(role('button', { name: 'Open src' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/src'),
        }),
      ),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/src'),
          listing: src,
        }),
      ),
      expectScene(
        within(
          role('list', { name: 'Folders in /Users/me/src' }),
          role('button', { name: 'Choose old' }),
        ),
      ).toBeAbsent(),
      click(role('button', { name: 'Choose app' })),
      expectScene(role('region', { name: 'Folders on local' })).toBeAbsent(),
      expectScene(label('Its folder on local')).toHaveValue(
        '/Users/me/src/app',
      ),
      click(role('button', { name: 'Add' })),
      SceneCommand.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.path.make({ path: '/Users/me/src/app' }),
          name: Option.none(),
        }),
      ),
      SceneCommand.resolve(
        Engines.AddProject,
        Engines.Message.FailedAddProject({ reason: 'it has no commits' }),
      ),
      expectScene(role('alert')).toHaveText('it has no commits'),
    )
  })

  test('the folder typed, refused, says why; Home lists the home folder; Close closes it', () => {
    scene(
      { update, view },
      givenScene(onScreen),
      type(label('Its folder on local'), '/Users/me/gone'),
      click(role('button', { name: 'Browse…' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/gone'),
        }),
      ),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.FailedFolders({
          engine: localEngineName,
          path: Option.some('/Users/me/gone'),
          reason: 'there is no folder at /Users/me/gone',
        }),
      ),
      expectScene(role('alert')).toHaveText(
        "Couldn't list the folder: there is no folder at /Users/me/gone",
      ),
      click(role('button', { name: 'Home' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({ engine: localEngineName, path: Option.none() }),
      ),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.none(),
          listing: home,
        }),
      ),
      click(role('button', { name: 'Choose this folder' })),
      expectScene(label('Its folder on local')).toHaveValue('/Users/me'),
      click(role('button', { name: 'Browse…' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({
          engine: localEngineName,
          path: Option.some('/Users/me'),
        }),
      ),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: localEngineName,
          path: Option.some('/Users/me'),
          listing: home,
        }),
      ),
      click(role('button', { name: 'Close' })),
      expectScene(role('region', { name: 'Folders on local' })).toBeAbsent(),
    )
  })
})
