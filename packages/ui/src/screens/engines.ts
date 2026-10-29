import { DateTime, Effect, Option, Redacted, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  CommandLine,
  CredentialInfo,
  CredentialName,
  CredentialValue,
  EngineStatus,
  ProjectId,
  ProjectInfo,
  ProjectSource,
  type ProjectStatus,
  ProviderName,
  Text,
} from '@fabrica/contracts'

import {
  Connection,
  type EngineConnectionService,
  localEngineName,
  requestEngine,
} from '../app/connection'
import { AppHost, ServiceInstall } from '../app/host'
import { type EngineProjects, runLabel } from '../console/sidebar'

// The Engines and projects screen (spec §18.4, §10.1, §20.3): the known engines with their versions
// and status, each engine's projects, whether the user trusts each (§12.1), Add project, and the
// engine's credentials, listed by name.
// The app reaches its local engine through the connection; the SSH, WSL2 and TLS engines and Add
// engine join it with remote engines (§9.2). A project is added as a checkout on the engine's host,
// by its path, or as a clone of a git URL, which the engine checks and, where `.fabrica/` is missing,
// offers to set up (`init`). A project is trusted or untrusted from its row, the words beside the
// list saying what trusting it lets its own files do. Credentials are set by name and removed, never shown (§20.3); the key a
// form holds is redacted, so no log or trace of the Model shows it. The local engine runs at login
// when the user chooses, which the app around the renderer installs (§7.1).

/** What a project is added from: a checkout on the engine's host, or a git URL (§10.1). */
export const SourceKind = Schema.Literals(['path', 'url'])
export type SourceKind = typeof SourceKind.Type

/** The add-project form, as typed. */
export const AddForm = Schema.Struct({
  kind: SourceKind,
  path: Schema.String,
  url: Schema.String,
  /** The project's name; the engine names it from its folder where it is left empty. */
  name: Schema.String,
})
export type AddForm = typeof AddForm.Type

/** The add-project flow. */
export const AddFlow = defineTaggedUnion({
  Closed: {},
  Editing: { form: AddForm, problem: Schema.Option(Schema.String) },
  /** Sent to the engine, which checks or clones it. */
  Adding: { form: AddForm },
})
export type AddFlow = typeof AddFlow.Type

/** A project just added, and its setting up, which the engine offers where its settings are missing. */
export const Setup = defineTaggedUnion({
  NotAsked: {},
  Running: {},
  Done: { written: Schema.Array(Text) },
  /** `init` failed; what it had written, which it lists (H62). */
  Failed: { reason: Schema.String, written: Schema.Array(Text) },
})
export type Setup = typeof Setup.Type

export const Added = Schema.Struct({ project: ProjectInfo, setup: Setup })
export type Added = typeof Added.Type

/** How a credential's value is given: a key, or a command whose output is the key (§20.3). */
export const ValueKind = Schema.Literals(['key', 'command'])
export type ValueKind = typeof ValueKind.Type

/** The set-credential form, as typed: the key kept redacted. */
export const CredentialForm = Schema.Struct({
  name: Schema.String,
  kind: ValueKind,
  key: Schema.Redacted(Schema.String),
  command: Schema.String,
  /** The provider the credential is for; none where left empty. */
  provider: Schema.String,
})
export type CredentialForm = typeof CredentialForm.Type

export const CredentialSave = defineTaggedUnion({
  Editing: { problem: Schema.Option(Schema.String) },
  Saving: {},
})
export type CredentialSave = typeof CredentialSave.Type

/** The local engine's login service, as the user chose it here (§7.1). */
export const LoginService = defineTaggedUnion({
  NotAsked: {},
  Installing: {},
  Installed: {},
  Failed: { reason: Schema.String },
})
export type LoginService = typeof LoginService.Type

export const Model = Schema.Struct({
  /** The local engine's status, asked as the screen opens. */
  status: AsyncData.Schema(EngineStatus, Schema.String).schema,
  addProject: AddFlow,
  added: Schema.Option(Added),
  credentials: AsyncData.Schema(Schema.Array(CredentialInfo), Schema.String)
    .schema,
  credentialForm: CredentialForm,
  credentialSave: CredentialSave,
  /** The project whose trust is being changed, and what the last change said where it failed. */
  trusting: Schema.Option(ProjectId),
  trustProblem: Schema.Option(Schema.String),
  /** The credential being removed, and what the last removal said where it failed. */
  removing: Schema.Option(CredentialName),
  removeProblem: Schema.Option(Schema.String),
  loginService: LoginService,
})
export type Model = typeof Model.Type

const emptyAddForm: AddForm = { kind: 'path', path: '', url: '', name: '' }

const emptyCredentialForm: CredentialForm = {
  name: '',
  kind: 'key',
  key: Redacted.make(''),
  command: '',
  provider: '',
}

export const init = (): Model => ({
  status: AsyncData.Idle(),
  addProject: AddFlow.Closed(),
  added: Option.none(),
  credentials: AsyncData.Idle(),
  credentialForm: emptyCredentialForm,
  credentialSave: CredentialSave.Editing({ problem: Option.none() }),
  trusting: Option.none(),
  trustProblem: Option.none(),
  removing: Option.none(),
  removeProblem: Option.none(),
  loginService: LoginService.NotAsked(),
})

export const Message = defineMessageUnion({
  SucceededLoadStatus: { status: EngineStatus },
  FailedLoadStatus: { reason: Schema.String },
  SucceededLoadCredentials: { credentials: Schema.Array(CredentialInfo) },
  FailedLoadCredentials: { reason: Schema.String },

  OpenedAddProject: {},
  ChoseSource: { kind: SourceKind },
  ChangedProjectPath: { path: Schema.String },
  ChangedProjectUrl: { url: Schema.String },
  ChangedProjectName: { name: Schema.String },
  SubmittedAddProject: {},
  CancelledAddProject: {},
  SucceededAddProject: { project: ProjectInfo },
  FailedAddProject: { reason: Schema.String },
  RequestedSetUp: { project: ProjectId },
  SucceededSetUp: { project: ProjectId, written: Schema.Array(Text) },
  FailedSetUp: {
    project: ProjectId,
    reason: Schema.String,
    written: Schema.Array(Text),
  },
  DismissedAdded: {},
  RequestedTrust: { project: ProjectId, trusted: Schema.Boolean },
  SucceededTrust: { project: ProjectId },
  FailedTrust: { project: ProjectId, reason: Schema.String },

  ChangedCredentialName: { name: Schema.String },
  ChoseValueKind: { kind: ValueKind },
  ChangedCredentialKey: { key: Schema.Redacted(Schema.String) },
  ChangedCredentialCommand: { command: Schema.String },
  ChangedCredentialProvider: { provider: Schema.String },
  SubmittedCredential: {},
  SucceededSetCredential: { name: CredentialName },
  FailedSetCredential: { reason: Schema.String },
  RequestedRemoveCredential: { name: CredentialName },
  SucceededRemoveCredential: { name: CredentialName },
  FailedRemoveCredential: { name: CredentialName, reason: Schema.String },

  RequestedLoginService: {},
  CompletedLoginService: { outcome: ServiceInstall },
})
export type Message = typeof Message.Type

// Commands: each a request to the engine, its failure in words.

export const LoadEngineStatus = Command.define('LoadEngineStatus', {
  messages: [Message.SucceededLoadStatus, Message.FailedLoadStatus],
  execute: requestEngine(client => client.rpc['engine.status']()).pipe(
    Effect.map(status => Message.SucceededLoadStatus({ status })),
    Effect.catch(reason =>
      Effect.succeed(Message.FailedLoadStatus({ reason })),
    ),
  ),
})

export const LoadCredentials = Command.define('LoadCredentials', {
  messages: [Message.SucceededLoadCredentials, Message.FailedLoadCredentials],
  execute: requestEngine(client => client.rpc['credentials.list']()).pipe(
    Effect.map(credentials =>
      Message.SucceededLoadCredentials({ credentials }),
    ),
    Effect.catch(reason =>
      Effect.succeed(Message.FailedLoadCredentials({ reason })),
    ),
  ),
})

export const AddProject = Command.define('AddProject', {
  args: { source: ProjectSource, name: Schema.Option(Text) },
  messages: [Message.SucceededAddProject, Message.FailedAddProject],
  execute: ({ source, name }) =>
    requestEngine(client => client.rpc['projects.add']({ source, name })).pipe(
      Effect.map(project => Message.SucceededAddProject({ project })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedAddProject({ reason })),
      ),
    ),
})

export const SetUpProject = Command.define('SetUpProject', {
  args: { project: ProjectId },
  messages: [Message.SucceededSetUp, Message.FailedSetUp],
  execute: ({ project }) =>
    requestEngine(client =>
      client.rpc['projects.init']({ project }).pipe(
        Effect.map(({ written }) =>
          Message.SucceededSetUp({ project, written }),
        ),
        Effect.catchTag('InitFailed', ({ reason, written }) =>
          Effect.succeed(Message.FailedSetUp({ project, reason, written })),
        ),
      ),
    ).pipe(
      Effect.catch(reason =>
        Effect.succeed(Message.FailedSetUp({ project, reason, written: [] })),
      ),
    ),
})

/** Gives or takes back the user's trust in the project; its row comes back changed on the status stream. */
export const SetProjectTrust = Command.define('SetProjectTrust', {
  args: { project: ProjectId, trusted: Schema.Boolean },
  messages: [Message.SucceededTrust, Message.FailedTrust],
  execute: ({ project, trusted }) =>
    requestEngine(client =>
      client.rpc['projects.trust']({ project, trusted }),
    ).pipe(
      Effect.as(Message.SucceededTrust({ project })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedTrust({ project, reason })),
      ),
    ),
})

export const SetCredential = Command.define('SetCredential', {
  args: {
    name: CredentialName,
    value: CredentialValue,
    provider: Schema.Option(ProviderName),
  },
  messages: [Message.SucceededSetCredential, Message.FailedSetCredential],
  execute: ({ name, value, provider }) =>
    requestEngine(client =>
      client.rpc['credentials.set']({ name, value, provider }),
    ).pipe(
      Effect.as(Message.SucceededSetCredential({ name })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedSetCredential({ reason })),
      ),
    ),
})

export const RemoveCredential = Command.define('RemoveCredential', {
  args: { name: CredentialName },
  messages: [Message.SucceededRemoveCredential, Message.FailedRemoveCredential],
  execute: ({ name }) =>
    requestEngine(client => client.rpc['credentials.remove']({ name })).pipe(
      Effect.as(Message.SucceededRemoveCredential({ name })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedRemoveCredential({ name, reason })),
      ),
    ),
})

/** What the login service says where no app is around the renderer to install it. */
export const noAppToInstall = 'only the desktop app installs the login service'

export const InstallLoginService = Command.define('InstallLoginService', {
  messages: [Message.CompletedLoginService],
  execute: Effect.gen(function* () {
    const host = yield* AppHost
    const outcome = yield* Option.getOrElse(host.installLoginService, () =>
      Effect.succeed(
        ServiceInstall.cases.Failed.make({ reason: noAppToInstall }),
      ),
    )
    return Message.CompletedLoginService({ outcome })
  }),
})

/** What the screen's Commands need: the engine connection, and the app around the renderer. */
export type Requires = EngineConnectionService | AppHost

type Return = Update.Return<Model, Message, Requires>

/** As the screen opens: the engine's status and credentials asked again, what was shown kept meanwhile. */
export const opened = (model: Model): Return => {
  const status = AsyncData.revalidateOrLoad(model.status)
  const credentials = AsyncData.revalidateOrLoad(model.credentials)
  return {
    model: modifyFields(model, {
      status: current => Option.getOrElse(status, () => current),
      credentials: current => Option.getOrElse(credentials, () => current),
    }),
    commands: [
      ...(Option.isSome(status) ? [LoadEngineStatus()] : []),
      ...(Option.isSome(credentials) ? [LoadCredentials()] : []),
    ],
  }
}

/** Opens the add-project flow, as the sidebar's "+ Add project" asks; one already open is kept. */
export const openAddProject = (model: Model): Model =>
  AddFlow.guards.Closed(model.addProject)
    ? modifyFields(model, {
        addProject: () =>
          AddFlow.Editing({ form: emptyAddForm, problem: Option.none() }),
      })
    : model

const decodeText = Schema.decodeUnknownOption(Text)
const decodeName = Schema.decodeUnknownOption(CredentialName)
const decodeProvider = Schema.decodeUnknownOption(ProviderName)
const decodeCommandLine = Schema.decodeUnknownOption(CommandLine)

/** Where the form's project comes from, or what is missing. */
export const sourceOf = (
  form: AddForm,
): Option.Option<{
  readonly source: ProjectSource
  readonly name: Option.Option<string>
}> => {
  const name = decodeText(form.name.trim())
  return form.kind === 'path'
    ? Option.map(decodeText(form.path.trim()), path => ({
        source: ProjectSource.cases.path.make({ path }),
        name,
      }))
    : Option.map(decodeText(form.url.trim()), url => ({
        source: ProjectSource.cases.url.make({ url }),
        name,
      }))
}

const missingSource = (kind: SourceKind): string =>
  kind === 'path'
    ? "Give the checkout's folder on the engine's host."
    : 'Give the git URL to clone.'

/** The form's credential, or what is wrong with it. */
export const credentialOf = (
  form: CredentialForm,
): Option.Option<{
  readonly name: CredentialName
  readonly value: CredentialValue
  readonly provider: Option.Option<ProviderName>
}> =>
  Option.all({
    name: decodeName(form.name.trim()),
    value:
      form.kind === 'key'
        ? Option.map(decodeText(Redacted.value(form.key)), key =>
            CredentialValue.cases.key.make({ key: Redacted.make(key) }),
          )
        : Option.map(decodeCommandLine(form.command.trim()), command =>
            CredentialValue.cases.command.make({ command }),
          ),
    provider: Option.some(decodeProvider(form.provider.trim())),
  })

const credentialProblem = (form: CredentialForm): string =>
  Option.isNone(decodeName(form.name.trim()))
    ? 'Give the credential a name, without spaces.'
    : form.kind === 'key'
      ? 'Give the key.'
      : 'Give the command that prints the key, on one line.'

/** Changes the add-project form while it is being edited; a form being added stays as it was sent. */
const editForm = (model: Model, change: (form: AddForm) => AddForm): Model =>
  AddFlow.match(model.addProject, {
    Editing: ({ form }) =>
      modifyFields(model, {
        addProject: () =>
          AddFlow.Editing({ form: change(form), problem: Option.none() }),
      }),
    Closed: () => model,
    Adding: () => model,
  })

const editCredential = (
  model: Model,
  change: (form: CredentialForm) => CredentialForm,
): Model =>
  CredentialSave.guards.Saving(model.credentialSave)
    ? model
    : modifyFields(model, {
        credentialForm: change,
        credentialSave: () =>
          CredentialSave.Editing({ problem: Option.none() }),
      })

/** The credentials listed again, after one was set or removed. */
const reloadCredentials = (model: Model): Return => {
  const credentials = AsyncData.revalidateOrLoad(model.credentials)
  return {
    model: modifyFields(model, {
      credentials: current => Option.getOrElse(credentials, () => current),
    }),
    commands: Option.isSome(credentials) ? [LoadCredentials()] : [],
  }
}

/** The added project's setup, where `project` is the one just added. */
const setAddedSetup = (model: Model, project: ProjectId, setup: Setup): Model =>
  modifyFields(model, {
    added: added =>
      Option.map(
        Option.filter(added, ({ project: info }) => info.id === project),
        current => ({ ...current, setup }),
      ).pipe(Option.orElse(() => added)),
  })

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SucceededLoadStatus: ({ status }) => ({
      model: modifyFields(model, { status: () => AsyncData.succeed(status) }),
    }),
    FailedLoadStatus: ({ reason }) => ({
      model: modifyFields(model, { status: () => AsyncData.fail(reason) }),
    }),
    SucceededLoadCredentials: ({ credentials }) => ({
      model: modifyFields(model, {
        credentials: () => AsyncData.succeed(credentials),
      }),
    }),
    FailedLoadCredentials: ({ reason }) => ({
      model: modifyFields(model, {
        credentials: () => AsyncData.fail(reason),
      }),
    }),

    OpenedAddProject: () => ({ model: openAddProject(model) }),
    ChoseSource: ({ kind }) => ({
      model: editForm(model, form => ({ ...form, kind })),
    }),
    ChangedProjectPath: ({ path }) => ({
      model: editForm(model, form => ({ ...form, path })),
    }),
    ChangedProjectUrl: ({ url }) => ({
      model: editForm(model, form => ({ ...form, url })),
    }),
    ChangedProjectName: ({ name }) => ({
      model: editForm(model, form => ({ ...form, name })),
    }),
    SubmittedAddProject: () =>
      AddFlow.match(model.addProject, {
        Editing: ({ form }): Return =>
          Option.match(sourceOf(form), {
            onNone: () => ({
              model: modifyFields(model, {
                addProject: () =>
                  AddFlow.Editing({
                    form,
                    problem: Option.some(missingSource(form.kind)),
                  }),
              }),
            }),
            onSome: ({ source, name }) => ({
              model: modifyFields(model, {
                addProject: () => AddFlow.Adding({ form }),
              }),
              commands: [AddProject({ source, name })],
            }),
          }),
        Closed: () => ({ model }),
        Adding: () => ({ model }),
      }),
    CancelledAddProject: () => ({
      model: AddFlow.guards.Editing(model.addProject)
        ? modifyFields(model, { addProject: () => AddFlow.Closed() })
        : model,
    }),
    SucceededAddProject: ({ project }) => ({
      model: modifyFields(model, {
        addProject: () => AddFlow.Closed(),
        added: () => Option.some({ project, setup: Setup.NotAsked() }),
      }),
    }),
    FailedAddProject: ({ reason }) => ({
      model: AddFlow.match(model.addProject, {
        Adding: ({ form }) =>
          modifyFields(model, {
            addProject: () =>
              AddFlow.Editing({ form, problem: Option.some(reason) }),
          }),
        Closed: () => model,
        Editing: () => model,
      }),
    }),
    RequestedSetUp: ({ project }) => ({
      model: setAddedSetup(model, project, Setup.Running()),
      commands: [SetUpProject({ project })],
    }),
    SucceededSetUp: ({ project, written }) => ({
      model: setAddedSetup(model, project, Setup.Done({ written })),
    }),
    FailedSetUp: ({ project, reason, written }) => ({
      model: setAddedSetup(model, project, Setup.Failed({ reason, written })),
    }),
    DismissedAdded: () => ({
      model: modifyFields(model, { added: () => Option.none() }),
    }),
    RequestedTrust: ({ project, trusted }) =>
      Option.isSome(model.trusting)
        ? { model }
        : {
            model: modifyFields(model, {
              trusting: () => Option.some(project),
              trustProblem: () => Option.none(),
            }),
            commands: [SetProjectTrust({ project, trusted })],
          },
    SucceededTrust: () => ({
      model: modifyFields(model, { trusting: () => Option.none() }),
    }),
    FailedTrust: ({ project, reason }) => ({
      model: modifyFields(model, {
        trusting: () => Option.none(),
        trustProblem: () =>
          Option.some(`Couldn't change the trust in ${project}: ${reason}`),
      }),
    }),

    ChangedCredentialName: ({ name }) => ({
      model: editCredential(model, form => ({ ...form, name })),
    }),
    ChoseValueKind: ({ kind }) => ({
      model: editCredential(model, form => ({ ...form, kind })),
    }),
    ChangedCredentialKey: ({ key }) => ({
      model: editCredential(model, form => ({ ...form, key })),
    }),
    ChangedCredentialCommand: ({ command }) => ({
      model: editCredential(model, form => ({ ...form, command })),
    }),
    ChangedCredentialProvider: ({ provider }) => ({
      model: editCredential(model, form => ({ ...form, provider })),
    }),
    SubmittedCredential: () =>
      CredentialSave.guards.Saving(model.credentialSave)
        ? { model }
        : Option.match(credentialOf(model.credentialForm), {
            onNone: () => ({
              model: modifyFields(model, {
                credentialSave: () =>
                  CredentialSave.Editing({
                    problem: Option.some(
                      credentialProblem(model.credentialForm),
                    ),
                  }),
              }),
            }),
            onSome: credential => ({
              model: modifyFields(model, {
                credentialSave: () => CredentialSave.Saving(),
              }),
              commands: [SetCredential(credential)],
            }),
          }),
    SucceededSetCredential: () =>
      reloadCredentials(
        modifyFields(model, {
          credentialForm: () => emptyCredentialForm,
          credentialSave: () =>
            CredentialSave.Editing({ problem: Option.none() }),
        }),
      ),
    FailedSetCredential: ({ reason }) => ({
      model: modifyFields(model, {
        credentialSave: () =>
          CredentialSave.Editing({ problem: Option.some(reason) }),
      }),
    }),
    RequestedRemoveCredential: ({ name }) =>
      Option.isSome(model.removing)
        ? { model }
        : {
            model: modifyFields(model, {
              removing: () => Option.some(name),
              removeProblem: () => Option.none(),
            }),
            commands: [RemoveCredential({ name })],
          },
    SucceededRemoveCredential: () =>
      reloadCredentials(modifyFields(model, { removing: () => Option.none() })),
    FailedRemoveCredential: ({ name, reason }) => ({
      model: modifyFields(model, {
        removing: () => Option.none(),
        removeProblem: () => Option.some(`Couldn't remove ${name}: ${reason}`),
      }),
    }),

    RequestedLoginService: () =>
      LoginService.guards.Installing(model.loginService)
        ? { model }
        : {
            model: modifyFields(model, {
              loginService: () => LoginService.Installing(),
            }),
            commands: [InstallLoginService()],
          },
    CompletedLoginService: ({ outcome }) => ({
      model: modifyFields(model, {
        loginService: () =>
          ServiceInstall.match(outcome, {
            Installed: (): LoginService => LoginService.Installed(),
            Failed: ({ reason }): LoginService =>
              LoginService.Failed({ reason }),
          }),
      }),
    }),
  })

// The view: the handoff's panel, card and list language (§18.2), since the handoff draws no screen
// but the console.

/** What the frame gives the screen: the connection, and each known engine's projects, as the sidebar holds them. */
export interface ViewInputs {
  readonly connection: Connection
  readonly engines: ReadonlyArray<EngineProjects>
}

const card = 'flex flex-col gap-10 rounded-card border border-line bg-panel'
const cardStyle = { padding: '12px 16px' }
const field =
  'rounded-button border border-line bg-bg px-10 py-6 text-sm text-fg'
const primaryButton =
  'rounded-button bg-c1 px-12 py-6 text-sm font-bold text-ink disabled:opacity-60'
const quietButton =
  'rounded-button border border-line px-10 py-4 text-xs text-fg disabled:opacity-60'

/** The connection's state in a word, and the role colour beside it (§18.2): none while it isn't settled. */
export const connectionWord = (
  connection: Connection,
): { readonly word: string; readonly tone: string } =>
  Connection.match(connection, {
    Connecting: () => ({ word: 'Connecting', tone: 'text-muted' }),
    Up: () => ({ word: 'Connected', tone: 'text-c1' }),
    Down: () => ({ word: 'Reconnecting', tone: 'text-c2' }),
    Failed: () => ({ word: 'Unreachable', tone: 'text-c3' }),
    Refused: ({ update }) => ({
      word: update === 'client' ? 'Needs a newer app' : 'Needs an update',
      tone: 'text-c3',
    }),
  })

const fact = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col'), h.Style({ gap: '2px' })],
    [
      h.dt([h.Class('text-xs text-muted')], [label]),
      h.dd([h.Class('font-mono text-xs')], [value]),
    ],
  )

const problemLine = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

/** The facts of the engine's status: its host, its start, its load of projects, runs and workers. */
const statusFacts = (status: EngineStatus, h: HtmlBuilder<Message>): Html =>
  h.dl(
    [
      h.Class('grid gap-10'),
      h.Style({ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }),
    ],
    [
      fact('Version', status.release, h),
      fact(
        'Host',
        `${status.host.hostname} · ${status.host.platform} ${status.host.arch}`,
        h,
      ),
      fact(
        'Started',
        DateTime.formatIso(status.startedAt).slice(0, 16).replace('T', ' '),
        h,
      ),
      fact('Projects', String(status.projects), h),
      fact('Runs', String(status.runs), h),
      fact('Workers', `${status.liveWorkers} of ${status.machineWorkers}`, h),
      fact('Clients', String(status.clients), h),
      fact('Cores', String(status.host.cores), h),
    ],
  )

const loginServiceView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-10')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.RequestedLoginService()),
          h.Disabled(LoginService.guards.Installing(model.loginService)),
          h.Class(quietButton),
        ],
        ['Run at login'],
      ),
      LoginService.match(model.loginService, {
        NotAsked: () =>
          h.span(
            [h.Class('text-xs text-muted')],
            [
              'Installs the engine as a login service, so it runs without the app.',
            ],
          ),
        Installing: () =>
          h.span(
            [h.Role('status'), h.Class('text-xs text-muted')],
            ['Installing…'],
          ),
        Installed: () =>
          h.span(
            [h.Role('status'), h.Class('text-xs text-c4')],
            ['Installed: the engine runs at login.'],
          ),
        Failed: ({ reason }) =>
          problemLine(`Couldn't install it: ${reason}`, h),
      }),
    ],
  )

const engineCard = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const state = connectionWord(inputs.connection)
  const protocol = Connection.match(inputs.connection, {
    Connecting: () => Option.none<string>(),
    Up: ({ release, protocol }) =>
      Option.some(`${release} · protocol ${protocol}`),
    Down: () => Option.none<string>(),
    Failed: () => Option.none<string>(),
    Refused: ({ engine }) => Option.some(`protocol ${engine}`),
  })
  return h.article(
    [
      h.AriaLabel(`Engine ${localEngineName}`),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-10')],
        [
          h.h3([h.Class('text-sm font-extrabold')], [localEngineName]),
          h.span([h.Class('text-xs text-muted')], ['This machine']),
          ...Option.match(protocol, {
            onNone: () => [],
            onSome: text => [
              h.span([h.Class('font-mono text-xs text-muted')], [text]),
            ],
          }),
          h.span(
            [
              h.DataAttribute('engine-state', inputs.connection._tag),
              h.Class(`ml-auto text-xs font-bold ${state.tone}`),
            ],
            [state.word],
          ),
        ],
      ),
      AsyncData.matchData(model.status, {
        onEmpty: () =>
          h.p(
            [h.Class('text-xs text-muted')],
            ['Asking the engine for its status…'],
          ),
        onFailure: reason =>
          problemLine(`Its status couldn't be read: ${reason}`, h),
        onData: status =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [
              statusFacts(status, h),
              status.stopping
                ? h.p(
                    [h.Role('status'), h.Class('text-xs text-c2')],
                    ['Winding its runs down to stop.'],
                  )
                : h.empty,
            ],
          ),
      }),
      loginServiceView(model, h),
    ],
  )
}

const sourceButton = (
  kind: SourceKind,
  chosen: SourceKind,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(kind === chosen ? 'true' : 'false'),
      h.OnClick(Message.ChoseSource({ kind })),
      h.Class(
        `rounded-button border px-10 py-4 text-xs ${kind === chosen ? 'border-c1 font-bold' : 'border-line text-muted'}`,
      ),
    ],
    [label],
  )

const labelled = (
  id: string,
  label: string,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-4')],
    [h.label([h.For(id), h.Class('text-xs text-muted')], [label]), control],
  )

const addProjectForm = (
  form: AddForm,
  problem: Option.Option<string>,
  adding: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.AriaLabel('Add project'),
      h.OnSubmit(Message.SubmittedAddProject()),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      h.div(
        [h.Role('group'), h.AriaLabel('Add from'), h.Class('flex gap-8')],
        [
          sourceButton('path', form.kind, "A checkout on the engine's host", h),
          sourceButton('url', form.kind, 'A git URL to clone', h),
        ],
      ),
      form.kind === 'path'
        ? labelled(
            'add-project-path',
            `Its folder on ${localEngineName}`,
            h.input([
              h.Id('add-project-path'),
              h.Type('text'),
              h.Value(form.path),
              h.Placeholder('/Users/me/src/app'),
              h.OnInput(path => Message.ChangedProjectPath({ path })),
              h.Disabled(adding),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          )
        : labelled(
            'add-project-url',
            'Its git URL',
            h.input([
              h.Id('add-project-url'),
              h.Type('text'),
              h.Value(form.url),
              h.Placeholder('git@github.com:me/app.git'),
              h.OnInput(url => Message.ChangedProjectUrl({ url })),
              h.Disabled(adding),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          ),
      labelled(
        'add-project-name',
        'Name (optional)',
        h.input([
          h.Id('add-project-name'),
          h.Type('text'),
          h.Value(form.name),
          h.OnInput(name => Message.ChangedProjectName({ name })),
          h.Disabled(adding),
          h.Class(field),
        ]),
        h,
      ),
      Option.match(problem, {
        onNone: () => h.empty,
        onSome: text => problemLine(text, h),
      }),
      h.div(
        [h.Class('flex items-center gap-8')],
        [
          h.button(
            [h.Type('submit'), h.Disabled(adding), h.Class(primaryButton)],
            [adding ? (form.kind === 'path' ? 'Adding…' : 'Cloning…') : 'Add'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.CancelledAddProject()),
              h.Disabled(adding),
              h.Class(quietButton),
            ],
            ['Cancel'],
          ),
        ],
      ),
    ],
  )

const addedView = (added: Added, h: HtmlBuilder<Message>): Html => {
  const { project, setup } = added
  const setUpLine = project.setUp
    ? h.span([h.Class('text-xs text-muted')], ['It is set up.'])
    : Setup.match(setup, {
        NotAsked: () =>
          h.span(
            [h.Class('flex items-center gap-8 text-xs')],
            [
              "It isn't set up: it has no .fabrica/ settings.",
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.RequestedSetUp({ project: project.id })),
                  h.Class(quietButton),
                ],
                ['Set it up'],
              ),
            ],
          ),
        Running: () =>
          h.span(
            [h.Role('status'), h.Class('text-xs text-muted')],
            ['Setting it up…'],
          ),
        Done: ({ written }) =>
          h.span(
            [h.Role('status'), h.Class('text-xs text-c4')],
            [`Set up: wrote ${written.join(', ')}.`],
          ),
        Failed: ({ reason, written }) =>
          problemLine(
            written.length === 0
              ? `Setting it up failed: ${reason}`
              : `Setting it up failed: ${reason}. It had written ${written.join(', ')}.`,
            h,
          ),
      })
  return h.div(
    [
      h.Role('status'),
      h.AriaLabel('Added project'),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-8')],
        [
          h.span(
            [h.Class('text-sm')],
            [
              `Added ${project.name}`,
              h.span(
                [h.Class('font-mono text-xs text-muted')],
                [
                  ` ${project.origin === 'cloned' ? 'cloned to' : 'at'} ${project.path}`,
                ],
              ),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.AriaLabel('Dismiss'),
              h.OnClick(Message.DismissedAdded()),
              h.Class('ml-auto text-xs text-muted'),
            ],
            ['×'],
          ),
        ],
      ),
      setUpLine,
    ],
  )
}

/** What trusting a project lets its own files do, beside the projects' list (§12.1, §20.2). */
export const trustWords =
  "Trusting a project lets its agents load its own .pi/ settings and packages: code from the project's files, run with your permissions. Trust only a project whose files you trust; a change reaches its agents as they next start."

const trustWordsId = 'project-trust-words'

/** A project's trust, in a word, and the button that changes it. */
const trustControl = (
  model: Model,
  project: ProjectStatus,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class('flex items-center gap-8')],
    [
      h.span(
        [
          h.DataAttribute('trusted', project.trusted ? 'true' : 'false'),
          h.Class(`text-xs ${project.trusted ? 'text-c4' : 'text-muted'}`),
        ],
        [project.trusted ? 'Trusted' : 'Untrusted'],
      ),
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(
            project.trusted
              ? `Stop trusting ${project.name}`
              : `Trust ${project.name}`,
          ),
          h.AriaDescribedBy(trustWordsId),
          h.OnClick(
            Message.RequestedTrust({
              project: project.project,
              trusted: !project.trusted,
            }),
          ),
          h.Disabled(Option.isSome(model.trusting)),
          h.Class(quietButton),
        ],
        [
          Option.contains(model.trusting, project.project)
            ? 'Changing…'
            : project.trusted
              ? 'Untrust'
              : 'Trust',
        ],
      ),
    ],
  )

const projectsView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const local = inputs.engines.find(engine => engine.name === localEngineName)
  const projects = Option.getOrElse(
    Option.flatMap(Option.fromUndefinedOr(local), engine => engine.projects),
    () => [],
  )
  return h.section(
    [
      h.AriaLabel(`Projects on ${localEngineName}`),
      h.Class('flex flex-col gap-8'),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-10')],
        [
          h.h2(
            [h.Class('text-sm font-extrabold')],
            [`Projects on ${localEngineName}`],
          ),
          h.span([h.Class('text-xs text-muted')], [String(projects.length)]),
          AddFlow.guards.Closed(model.addProject)
            ? h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.OpenedAddProject()),
                  h.Class(`ml-auto ${primaryButton}`),
                ],
                ['+ Add project'],
              )
            : h.empty,
        ],
      ),
      AddFlow.match(model.addProject, {
        Closed: () => h.empty,
        Editing: ({ form, problem }) => addProjectForm(form, problem, false, h),
        Adding: ({ form }) => addProjectForm(form, Option.none(), true, h),
      }),
      Option.match(model.added, {
        onNone: () => h.empty,
        onSome: added => addedView(added, h),
      }),
      projects.length === 0
        ? h.p([h.Class('text-xs text-muted')], ['No projects yet.'])
        : h.ul(
            [h.Class(card), h.Style({ padding: '4px 0' })],
            projects.map(project => {
              const state = runLabel(project.run)
              return h.keyed('li')(
                project.project,
                [
                  h.Class('grid items-center gap-10 text-sm'),
                  h.Style({
                    gridTemplateColumns: 'minmax(0,1fr) auto auto auto',
                    padding: '6px 16px',
                  }),
                ],
                [
                  h.span(
                    [h.Class('flex min-w-0 flex-col'), h.Style({ gap: '2px' })],
                    [
                      h.span(
                        [h.Class('truncate font-semibold')],
                        [project.name],
                      ),
                      h.span(
                        [h.Class('font-mono text-xs text-muted')],
                        [project.base],
                      ),
                    ],
                  ),
                  project.setUp
                    ? h.span([])
                    : h.span([h.Class('text-xs text-c2')], ['Not set up']),
                  h.span([h.Class('text-xs text-muted')], [state.word]),
                  trustControl(model, project, h),
                ],
              )
            }),
          ),
      Option.match(model.trustProblem, {
        onNone: () => h.empty,
        onSome: text => problemLine(text, h),
      }),
      projects.length === 0
        ? h.empty
        : h.p(
            [h.Id(trustWordsId), h.Class('text-xs text-muted')],
            [trustWords],
          ),
    ],
  )
}

const credentialsList = (
  model: Model,
  credentials: ReadonlyArray<CredentialInfo>,
  h: HtmlBuilder<Message>,
): Html =>
  credentials.length === 0
    ? h.p([h.Class('text-xs text-muted')], ['No credentials yet.'])
    : h.ul(
        [h.Class(card), h.Style({ padding: '4px 0' })],
        credentials.map(credential =>
          h.keyed('li')(
            credential.name,
            [
              h.Class('grid items-center gap-10 text-sm'),
              h.Style({
                gridTemplateColumns: 'minmax(0,1fr) auto auto auto',
                padding: '6px 16px',
              }),
            ],
            [
              h.span([h.Class('truncate font-mono')], [credential.name]),
              h.span(
                [h.Class('text-xs text-muted')],
                [Option.getOrElse(credential.provider, () => '')],
              ),
              h.span([h.Class('text-xs text-muted')], [credential.kind]),
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel(`Remove ${credential.name}`),
                  h.OnClick(
                    Message.RequestedRemoveCredential({
                      name: credential.name,
                    }),
                  ),
                  h.Disabled(Option.isSome(model.removing)),
                  h.Class(quietButton),
                ],
                [
                  Option.contains(model.removing, credential.name)
                    ? 'Removing…'
                    : 'Remove',
                ],
              ),
            ],
          ),
        ),
      )

const credentialFormView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const form = model.credentialForm
  const saving = CredentialSave.guards.Saving(model.credentialSave)
  return h.form(
    [
      h.AriaLabel('Set a credential'),
      h.OnSubmit(Message.SubmittedCredential()),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      h.div(
        [
          h.Class('grid gap-10'),
          h.Style({ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }),
        ],
        [
          labelled(
            'credential-name',
            'Name',
            h.input([
              h.Id('credential-name'),
              h.Type('text'),
              h.Value(form.name),
              h.Placeholder('anthropic'),
              h.OnInput(name => Message.ChangedCredentialName({ name })),
              h.Disabled(saving),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          ),
          labelled(
            'credential-provider',
            'Provider (optional)',
            h.input([
              h.Id('credential-provider'),
              h.Type('text'),
              h.Value(form.provider),
              h.Placeholder('anthropic'),
              h.OnInput(provider =>
                Message.ChangedCredentialProvider({ provider }),
              ),
              h.Disabled(saving),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          ),
          h.div(
            [
              h.Role('group'),
              h.AriaLabel('Given as'),
              h.Class('flex items-end gap-8'),
            ],
            (
              [
                ['key', 'A key'],
                ['command', 'A command'],
              ] as const
            ).map(([kind, label]) =>
              h.button(
                [
                  h.Type('button'),
                  h.AriaPressed(form.kind === kind ? 'true' : 'false'),
                  h.OnClick(Message.ChoseValueKind({ kind })),
                  h.Class(
                    `rounded-button border px-10 py-4 text-xs ${form.kind === kind ? 'border-c1 font-bold' : 'border-line text-muted'}`,
                  ),
                ],
                [label],
              ),
            ),
          ),
        ],
      ),
      form.kind === 'key'
        ? labelled(
            'credential-key',
            'Key',
            h.input([
              h.Id('credential-key'),
              h.Type('password'),
              h.Value(Redacted.value(form.key)),
              h.Autocomplete('off'),
              h.OnInput(key =>
                Message.ChangedCredentialKey({ key: Redacted.make(key) }),
              ),
              h.Disabled(saving),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          )
        : labelled(
            'credential-command',
            'Command that prints the key',
            h.input([
              h.Id('credential-command'),
              h.Type('text'),
              h.Value(form.command),
              h.Placeholder('op read op://dev/anthropic/key'),
              h.OnInput(command =>
                Message.ChangedCredentialCommand({ command }),
              ),
              h.Disabled(saving),
              h.Class(`font-mono ${field}`),
            ]),
            h,
          ),
      CredentialSave.match(model.credentialSave, {
        Editing: ({ problem }) =>
          Option.match(problem, {
            onNone: () => h.empty,
            onSome: text => problemLine(text, h),
          }),
        Saving: () => h.empty,
      }),
      h.div(
        [h.Class('flex items-center gap-8')],
        [
          h.button(
            [h.Type('submit'), h.Disabled(saving), h.Class(primaryButton)],
            [saving ? 'Saving…' : 'Save'],
          ),
          h.span(
            [h.Class('text-xs text-muted')],
            [
              'Sent once to the engine, kept in its host’s secret store, never shown again.',
            ],
          ),
        ],
      ),
    ],
  )
}

const credentialsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.AriaLabel('Credentials'), h.Class('flex flex-col gap-8')],
    [
      h.h2([h.Class('text-sm font-extrabold')], ['Credentials']),
      AsyncData.matchData(model.credentials, {
        onEmpty: () =>
          h.p(
            [h.Class('text-xs text-muted')],
            ['Asking the engine for its credentials…'],
          ),
        onFailure: reason =>
          problemLine(`The credentials couldn't be listed: ${reason}`, h),
        onData: credentials => credentialsList(model, credentials, h),
      }),
      Option.match(model.removeProblem, {
        onNone: () => h.empty,
        onSome: text => problemLine(text, h),
      }),
      credentialFormView(model, h),
    ],
  )

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-16 overflow-auto')],
    [
      h.section(
        [h.AriaLabel('Engines'), h.Class('flex flex-col gap-8')],
        [
          h.h2([h.Class('text-sm font-extrabold')], ['Engines']),
          engineCard(model, inputs, h),
        ],
      ),
      projectsView(model, inputs, h),
      credentialsView(model, h),
    ],
  ),
)
