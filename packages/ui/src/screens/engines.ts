import {
  Data,
  DateTime,
  Effect,
  Equal,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect'
import { Command, type Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  CheckAnswer,
  EngineAddress,
  EngineHost,
  EngineInstalled,
  EngineName,
  FingerprintAnswer,
  HostCheck,
  InstallAnswer,
  InstallConsent,
  InstallPlan,
  PairAnswer,
  SshDestination,
  TlsEndpoint,
  UbuntuInstall,
  WslSearch,
  consentFor,
  defaultEngineName,
  parseTlsEndpoint,
  tlsEndpointText,
  windowsDriveWarning,
} from '@fabrica/client'
import {
  CertificateFingerprint,
  CommandLine,
  CredentialInfo,
  CredentialName,
  CredentialValue,
  EngineStatus,
  FolderListing,
  type HostFolder,
  type Platform,
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
import type * as RemoteEngines from '../app/remote-engines'
import { type EngineProjects, runLabel } from '../console/sidebar'

// The Engines and projects screen (spec §18.4, §10.1, §20.3): the known engines with their versions
// and status, each engine's projects, whether the user trusts each (§12.1), Add project, and the
// engine's credentials, listed by name.
// The app reaches its local engine through the connection, and each known engine on another host
// through its own (§9.1), each with its card. Add engine takes an SSH destination and the engine's name
// (its host's, where none is given), and has the app check the host (its system, the engine there and
// its version), then install the app's engine there, or update an older one, only once the user agrees
// to what the check proposes (§9.2); the engine installed, or found up to date, joins the known engines
// and is connected to. On Windows it offers WSL2 too (§7.6): the distribution the app found is checked
// the same way, and where there is none the app offers to install Ubuntu, or says why WSL can't run. An
// engine over TLS is paired with instead (§9.3): Add engine takes its TLS address and a pairing token,
// the app reads the fingerprint of the certificate the engine presents there and shows it, and only once
// the user accepts it does the engine join the known engines, its fingerprint pinned and its token kept
// by the app; a paired engine whose certificate changed, or whose token was refused, stops, saying so,
// and is offered pairing again. An
// engine that refuses the app's version at connect is offered its update the same way, on this machine
// or over SSH on its host (§8.4); an app too old for its engine is told to update itself. A project is
// added as a checkout on the engine's host,
// by its path, typed or found by browsing the host's folders through the engine (from the path typed,
// or its home folder), or as a clone of a git URL, which the engine checks and, where `.fabrica/` is
// missing, offers to set up (`init`); a checkout on a Windows drive, as a WSL2 engine sees it under
// `/mnt/<letter>`, is warned about. A project is trusted or untrusted from its row, the words beside the
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

/**
 * The engine host's folders, browsed for the checkout to add (§10.1): the engine lists them, so a
 * remote engine's host is browsed as this machine's is. A folder is asked by its path, the engine's
 * home folder where none is given; only the answer to the folder last asked is shown.
 */
export const FolderBrowser = defineTaggedUnion({
  Closed: {},
  Loading: { path: Schema.Option(Text) },
  Shown: { listing: FolderListing },
  Failed: { path: Schema.Option(Text), reason: Schema.String },
})
export type FolderBrowser = typeof FolderBrowser.Type

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

/** Where installing an engine on a host stands (§9.2): checked, agreed to, installed. */
export const SetupStep = defineTaggedUnion({
  Checking: {},
  /** What the check found and proposes, for the user to agree to. */
  Checked: { check: HostCheck },
  Installing: { consent: InstallConsent },
  Installed: { installed: EngineInstalled },
  Failed: { reason: Schema.String },
})
export type SetupStep = typeof SetupStep.Type

/** Where finding a WSL2 distribution to add an engine in stands (§7.6). */
export const WslStep = defineTaggedUnion({
  Searching: {},
  Searched: { search: WslSearch },
  /** Ubuntu installing in WSL's own window, as the user agreed. */
  InstallingUbuntu: {},
  UbuntuUnfinished: { reason: Schema.String },
})
export type WslStep = typeof WslStep.Type

/** Where pairing with an engine over TLS stands (§9.3): its certificate read, accepted, paired. */
export const PairStep = defineTaggedUnion({
  /** The fingerprint of the certificate the engine presents, being read. */
  Reading: {},
  /** Read, for the user to compare and accept. */
  Read: { fingerprint: CertificateFingerprint },
  /** Accepted: the app takes the pairing. */
  Pairing: { fingerprint: CertificateFingerprint },
  /** The app took it: the engine joins the known engines, connected to. */
  Paired: { fingerprint: CertificateFingerprint },
  Failed: { reason: Schema.String },
})
export type PairStep = typeof PairStep.Type

/** Add engine, and the update offered to an engine that refused the app at connect (§9.2, §8.4). */
export const EngineSetup = defineTaggedUnion({
  Closed: {},
  /** The host's SSH destination and the engine's name, as typed. */
  Editing: {
    destination: Schema.String,
    name: Schema.String,
    problem: Schema.Option(Schema.String),
  },
  /** An engine over TLS (§9.3): its address, the pairing token and the engine's name, as typed. */
  EditingTls: {
    address: Schema.String,
    token: Schema.Redacted(Schema.String),
    name: Schema.String,
    problem: Schema.Option(Schema.String),
  },
  /** Pairing with the engine named `name` at `endpoint`, with the token typed. */
  Pairing: {
    name: EngineName,
    endpoint: TlsEndpoint,
    token: Schema.Redacted(Schema.String),
    step: PairStep,
  },
  /** A WSL2 distribution to add the engine in, being found (§7.6). */
  Wsl: { step: WslStep },
  /** On `host`; `name` the engine's among the known engines, none for this machine's. */
  Running: {
    host: EngineHost,
    name: Schema.Option(EngineName),
    step: SetupStep,
  },
})
export type EngineSetup = typeof EngineSetup.Type

export const Model = Schema.Struct({
  /** The local engine's status, asked as the screen opens. */
  status: AsyncData.Schema(EngineStatus, Schema.String).schema,
  addProject: AddFlow,
  folders: FolderBrowser,
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
  engineSetup: EngineSetup,
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
  folders: FolderBrowser.Closed(),
  added: Option.none(),
  credentials: AsyncData.Idle(),
  credentialForm: emptyCredentialForm,
  credentialSave: CredentialSave.Editing({ problem: Option.none() }),
  trusting: Option.none(),
  trustProblem: Option.none(),
  removing: Option.none(),
  removeProblem: Option.none(),
  loginService: LoginService.NotAsked(),
  engineSetup: EngineSetup.Closed(),
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
  /** Browse from the path typed, or the engine's home folder where none is. */
  OpenedFolders: {},
  RequestedFolders: { path: Schema.Option(Text) },
  SucceededFolders: { path: Schema.Option(Text), listing: FolderListing },
  FailedFolders: { path: Schema.Option(Text), reason: Schema.String },
  ChoseFolder: { path: Text },
  ClosedFolders: {},
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

  OpenedAddEngine: {},
  ChangedEngineDestination: { destination: Schema.String },
  ChangedEngineName: { name: Schema.String },
  SubmittedAddEngine: {},
  /** The update offered to the engine that refused the app at connect: this machine's. */
  RequestedEngineUpdate: {},
  /** The update offered to the known engine named `name` that refused the app, on its host over SSH. */
  RequestedRemoteUpdate: { name: EngineName, destination: SshDestination },
  /** The user tried the known engine named `name` again, whose connection had stopped. */
  RetriedRemote: { name: EngineName },
  CompletedEngineCheck: { host: EngineHost, answer: CheckAnswer },
  /** The user agreed to what the check proposes. */
  ConsentedInstall: {},
  CompletedEngineInstall: { host: EngineHost, answer: InstallAnswer },
  RetriedEngineCheck: {},
  ClosedEngineSetup: {},
  /** Add engine in WSL2 rather than over SSH: the distribution is looked for (again). */
  ChoseWslEngine: {},
  /** Add engine over SSH rather than in WSL2. */
  ChoseSshEngine: {},
  CompletedWslSearch: { search: WslSearch },
  RequestedUbuntuInstall: {},
  CompletedUbuntuInstall: { outcome: UbuntuInstall },
  /** Check the distribution found for an engine. */
  RequestedWslCheck: {},
  /** Add engine over TLS, with a pairing token (§9.3). */
  ChoseTlsEngine: {},
  ChangedEngineAddress: { address: Schema.String },
  ChangedEngineToken: { token: Schema.Redacted(Schema.String) },
  CompletedFingerprintRead: {
    endpoint: TlsEndpoint,
    answer: FingerprintAnswer,
  },
  /** The user accepted the fingerprint read. */
  AcceptedFingerprint: {},
  /** Read the engine's certificate again, after a read or a pairing failed. */
  RetriedFingerprintRead: {},
  CompletedPairing: { name: EngineName, answer: PairAnswer },
  /** Pair the known engine named `name` again, at `endpoint`: its certificate changed, or its token was refused. */
  RequestedRepair: { name: EngineName, endpoint: TlsEndpoint },
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

/** Lists a folder on the engine's host: its home folder where no path is given. */
export const LoadFolders = Command.define('LoadFolders', {
  args: { path: Schema.Option(Text) },
  messages: [Message.SucceededFolders, Message.FailedFolders],
  execute: ({ path }) =>
    requestEngine(client => client.rpc['projects.folders']({ path })).pipe(
      Effect.map(listing => Message.SucceededFolders({ path, listing })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedFolders({ path, reason })),
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

/** What checking and installing engines say where no app is around the renderer to do it. */
export const noAppToInstallEngines = 'only the desktop app installs engines'

export const CheckEngine = Command.define('CheckEngine', {
  args: { host: EngineHost },
  messages: [Message.CompletedEngineCheck],
  execute: ({ host }) =>
    Effect.gen(function* () {
      const app = yield* AppHost
      const answer = yield* Option.match(app.checkEngine, {
        onNone: () =>
          Effect.succeed(
            CheckAnswer.cases.Failed.make({ reason: noAppToInstallEngines }),
          ),
        onSome: check => check(host),
      })
      return Message.CompletedEngineCheck({ host, answer })
    }),
})

export const InstallEngine = Command.define('InstallEngine', {
  args: { host: EngineHost, consent: InstallConsent },
  messages: [Message.CompletedEngineInstall],
  execute: ({ host, consent }) =>
    Effect.gen(function* () {
      const app = yield* AppHost
      const answer = yield* Option.match(app.installEngine, {
        onNone: () =>
          Effect.succeed(
            InstallAnswer.cases.Failed.make({ reason: noAppToInstallEngines }),
          ),
        onSome: install => install({ host, consent }),
      })
      return Message.CompletedEngineInstall({ host, answer })
    }),
})

/** What the WSL2 search and Ubuntu's install say where no app is around the renderer to do them. */
export const noAppForWsl = 'only the Windows app runs engines in WSL2'

export const FindWsl = Command.define('FindWsl', {
  messages: [Message.CompletedWslSearch],
  execute: Effect.gen(function* () {
    const app = yield* AppHost
    const search = yield* Option.getOrElse(app.findWsl, () =>
      Effect.succeed(WslSearch.cases.Unavailable.make({ reason: noAppForWsl })),
    )
    return Message.CompletedWslSearch({ search })
  }),
})

export const InstallUbuntu = Command.define('InstallUbuntu', {
  messages: [Message.CompletedUbuntuInstall],
  execute: Effect.gen(function* () {
    const app = yield* AppHost
    const outcome = yield* Option.getOrElse(app.installUbuntu, () =>
      Effect.succeed(
        UbuntuInstall.cases.Unfinished.make({ reason: noAppForWsl }),
      ),
    )
    return Message.CompletedUbuntuInstall({ outcome })
  }),
})

/** What pairing says where no app is around the renderer to do it. */
export const noAppToPair = 'only the desktop app pairs with engines'

export const ReadFingerprint = Command.define('ReadFingerprint', {
  args: { endpoint: TlsEndpoint },
  messages: [Message.CompletedFingerprintRead],
  execute: ({ endpoint }) =>
    Effect.gen(function* () {
      const app = yield* AppHost
      const answer = yield* Option.match(app.readFingerprint, {
        onNone: () =>
          Effect.succeed(
            FingerprintAnswer.cases.Failed.make({ reason: noAppToPair }),
          ),
        onSome: read => read(endpoint),
      })
      return Message.CompletedFingerprintRead({ endpoint, answer })
    }),
})

export const PairEngine = Command.define('PairEngine', {
  args: {
    name: EngineName,
    endpoint: TlsEndpoint,
    fingerprint: CertificateFingerprint,
    token: Schema.Redacted(Schema.NonEmptyString),
  },
  messages: [Message.CompletedPairing],
  execute: request =>
    Effect.gen(function* () {
      const app = yield* AppHost
      const answer = yield* Option.match(app.pairEngine, {
        onNone: () =>
          Effect.succeed(PairAnswer.cases.Failed.make({ reason: noAppToPair })),
        onSome: pair => pair(request),
      })
      return Message.CompletedPairing({ name: request.name, answer })
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

/** The folder at `path` asked of the engine, where a checkout's path is being edited. */
const browse = (model: Model, path: Option.Option<string>): Return =>
  AddFlow.guards.Editing(model.addProject) &&
  model.addProject.form.kind === 'path'
    ? {
        model: modifyFields(model, {
          folders: () => FolderBrowser.Loading({ path }),
        }),
        commands: [LoadFolders({ path })],
      }
    : { model }

/** The browser moved on to `next`, where it is waiting on the folder at `path`. */
const answerFolders = (
  model: Model,
  path: Option.Option<string>,
  next: FolderBrowser,
): Model =>
  FolderBrowser.guards.Loading(model.folders) &&
  Equal.equals(model.folders.path, path)
    ? modifyFields(model, { folders: () => next })
    : model

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

const decodeDestination = Schema.decodeUnknownOption(SshDestination)

/** Whether two hosts are the same one. */
export const sameHost = (a: EngineHost, b: EngineHost): boolean =>
  EngineHost.match(a, {
    Local: () => EngineHost.guards.Local(b),
    Ssh: ({ destination }) =>
      EngineHost.guards.Ssh(b) && b.destination === destination,
    Wsl: ({ distro }) => EngineHost.guards.Wsl(b) && b.distro === distro,
  })

/**
 * Whether the setup is waiting on the app: a check, an install, a search for a WSL2 distribution or
 * Ubuntu's install, a certificate's read or a pairing under way, which nothing else interrupts.
 */
const busy = (setup: EngineSetup): boolean =>
  EngineSetup.match(setup, {
    Closed: () => false,
    Editing: () => false,
    EditingTls: () => false,
    Pairing: ({ step }) =>
      PairStep.guards.Reading(step) || PairStep.guards.Pairing(step),
    Wsl: ({ step }) =>
      WslStep.guards.Searching(step) || WslStep.guards.InstallingUbuntu(step),
    Running: ({ step }) =>
      SetupStep.guards.Checking(step) || SetupStep.guards.Installing(step),
  })

/** The WSL2 search's step moved on by `next`, where it is under way; any other setup is kept. */
const stepWsl = (
  model: Model,
  next: (step: WslStep) => Option.Option<WslStep>,
): Model =>
  EngineSetup.match(model.engineSetup, {
    Wsl: ({ step }) =>
      Option.match(next(step), {
        onNone: () => model,
        onSome: moved =>
          modifyFields(model, {
            engineSetup: () => EngineSetup.Wsl({ step: moved }),
          }),
      }),
    Closed: () => model,
    Editing: () => model,
    EditingTls: () => model,
    Pairing: () => model,
    Running: () => model,
  })

/** The distribution the WSL2 search found, where it has found one. */
const foundDistro = (setup: EngineSetup): Option.Option<WslSearch> =>
  EngineSetup.guards.Wsl(setup) && WslStep.guards.Searched(setup.step)
    ? Option.some(setup.step.search)
    : Option.none()

/** The host is checked: the setup running on it, for the engine named `name`, and the check asked. */
const startCheck = (
  model: Model,
  host: EngineHost,
  name: Option.Option<EngineName>,
): Return => ({
  model: modifyFields(model, {
    engineSetup: () =>
      EngineSetup.Running({ host, name, step: SetupStep.Checking() }),
  }),
  commands: [CheckEngine({ host })],
})

/** The setup's step moved on by `next`, where it is running on `host`; any other setup is kept. */
const stepSetup = (
  model: Model,
  host: EngineHost,
  next: (step: SetupStep) => Option.Option<SetupStep>,
): Model =>
  EngineSetup.match(model.engineSetup, {
    Running: running =>
      sameHost(running.host, host)
        ? Option.match(next(running.step), {
            onNone: () => model,
            onSome: step =>
              modifyFields(model, {
                engineSetup: () => EngineSetup.Running({ ...running, step }),
              }),
          })
        : model,
    Closed: () => model,
    Editing: () => model,
    EditingTls: () => model,
    Pairing: () => model,
    Wsl: () => model,
  })

/** The pairing's step moved on by `next`, where it is pairing with `endpoint`; any other setup is kept. */
const stepPairing = (
  model: Model,
  endpoint: TlsEndpoint,
  next: (step: PairStep) => Option.Option<PairStep>,
): Model =>
  EngineSetup.guards.Pairing(model.engineSetup) &&
  sameEndpoint(model.engineSetup.endpoint, endpoint)
    ? Option.match(next(model.engineSetup.step), {
        onNone: () => model,
        onSome: step =>
          modifyFields(model, {
            engineSetup: setup =>
              EngineSetup.guards.Pairing(setup)
                ? EngineSetup.Pairing({ ...setup, step })
                : setup,
          }),
      })
    : model

/** Whether two endpoints are the same. */
const sameEndpoint = (a: TlsEndpoint, b: TlsEndpoint): boolean =>
  a.host === b.host && a.port === b.port

/** The pairing with the engine named `name` at `endpoint` begun: its certificate read. */
const startPairing = (
  model: Model,
  pairing: {
    readonly name: EngineName
    readonly endpoint: TlsEndpoint
    readonly token: Redacted.Redacted<string>
  },
): Return => ({
  model: modifyFields(model, {
    engineSetup: () =>
      EngineSetup.Pairing({ ...pairing, step: PairStep.Reading() }),
  }),
  commands: [ReadFingerprint({ endpoint: pairing.endpoint })],
})

/**
 * Whether `message` means the engine this app connects to may take it now: this machine's engine, or
 * the one in WSL2 the Windows app reaches, installed or updated, so a connection it refused is tried
 * again.
 */
export const reconnectsAfter = (message: Message): boolean =>
  Match.value(message).pipe(
    Match.tag(
      'CompletedEngineInstall',
      ({ host, answer }) =>
        !EngineHost.guards.Ssh(host) && InstallAnswer.guards.Installed(answer),
    ),
    Match.orElse(() => false),
  )

/** What the screen's Message changes among the known engines on other hosts (§9.1). */
export type RemoteChange = Data.TaggedEnum<{
  /** Installed by Add engine, found up to date, or paired: it joins the known engines, connected to. */
  Added: { readonly name: EngineName; readonly address: EngineAddress }
  /** The user tried its connection again. */
  Retried: { readonly name: EngineName }
}>
export const RemoteChange = Data.taggedEnum<RemoteChange>()

/** The name of the engine the setup on the SSH host `host` is for, while it is at `at`. */
const settingUp = (
  model: Model,
  host: EngineHost,
  at: (step: SetupStep) => boolean,
): Option.Option<{
  readonly name: EngineName
  readonly address: EngineAddress
}> =>
  EngineSetup.guards.Running(model.engineSetup) &&
  EngineHost.guards.Ssh(host) &&
  sameHost(model.engineSetup.host, host) &&
  at(model.engineSetup.step)
    ? Option.map(model.engineSetup.name, name => ({
        name,
        address: EngineAddress.cases.Ssh.make({
          destination: host.destination,
        }),
      }))
    : Option.none()

/**
 * What `message`, coming to the screen as `model`, changes among the known engines: an engine on an SSH
 * host installed or updated, or found up to date, or one over TLS paired with, its fingerprint
 * pinned, joins them (or one of its name is connected to again, at its new address); the user's try
 * again reaches its engine.
 */
export const remoteAfter = (
  model: Model,
  message: Message,
): Option.Option<RemoteChange> =>
  Match.value(message).pipe(
    Match.tag('CompletedEngineInstall', ({ host, answer }) =>
      InstallAnswer.guards.Installed(answer)
        ? Option.map(
            settingUp(model, host, SetupStep.guards.Installing),
            RemoteChange.Added,
          )
        : Option.none(),
    ),
    Match.tag('CompletedEngineCheck', ({ host, answer }) =>
      CheckAnswer.guards.Checked(answer) &&
      InstallPlan.guards.Current(answer.check.plan)
        ? Option.map(
            settingUp(model, host, SetupStep.guards.Checking),
            RemoteChange.Added,
          )
        : Option.none(),
    ),
    Match.tag('CompletedPairing', ({ name, answer }) =>
      PairAnswer.guards.Paired(answer) &&
      EngineSetup.guards.Pairing(model.engineSetup) &&
      model.engineSetup.name === name &&
      PairStep.guards.Pairing(model.engineSetup.step)
        ? Option.some(
            RemoteChange.Added({
              name,
              address: EngineAddress.cases.Tls.make({
                ...model.engineSetup.endpoint,
                fingerprint: model.engineSetup.step.fingerprint,
              }),
            }),
          )
        : Option.none(),
    ),
    Match.tag('RetriedRemote', ({ name }) =>
      Option.some(RemoteChange.Retried({ name })),
    ),
    Match.orElse(() => Option.none()),
  )

/** Add engine's form, as typed. */
interface EngineForm {
  readonly destination: string
  readonly name: string
}

/** Add engine's form over TLS, as typed. */
interface TlsForm {
  readonly address: string
  readonly token: Redacted.Redacted<string>
  readonly name: string
}

/** Add engine's form changed by `change`, or its form over TLS by `changeTls`, while typed; its problem cleared. */
const editEngine = (
  model: Model,
  change: (typed: EngineForm) => EngineForm,
  changeTls: (typed: TlsForm) => TlsForm = typed => typed,
): Model =>
  EngineSetup.match(model.engineSetup, {
    Editing: ({ destination, name }) =>
      modifyFields(model, {
        engineSetup: () =>
          EngineSetup.Editing({
            ...change({ destination, name }),
            problem: Option.none(),
          }),
      }),
    EditingTls: ({ address, token, name }) =>
      modifyFields(model, {
        engineSetup: () =>
          EngineSetup.EditingTls({
            ...changeTls({ address, token, name }),
            problem: Option.none(),
          }),
      }),
    Closed: () => model,
    Wsl: () => model,
    Pairing: () => model,
    Running: () => model,
  })

/**
 * The name Add engine's form gives the engine it reaches, or why it can't take it: the name of the
 * known engine already reached there (`reachedThere`), else the name typed, else `fallback`.
 */
const engineName = (
  typed: string,
  {
    reachedThere,
    fallback,
  }: {
    readonly reachedThere: (address: EngineAddress) => boolean
    readonly fallback: string
  },
  known: ReadonlyArray<RemoteEngines.RemoteEngine>,
): Result.Result<EngineName, string> => {
  const there = known.find(engine => reachedThere(engine.address))
  if (there !== undefined) {
    return Result.succeed(there.name)
  }
  const name = typed.trim() === '' ? fallback : typed.trim()
  if (name === '' || name === localEngineName) {
    return Result.fail(
      `${localEngineName} names this machine’s engine: give the engine another name.`,
    )
  }
  return known.some(engine => engine.name === name)
    ? Result.fail(
        `${name} names another of the app’s engines: give this one another name.`,
      )
    : Result.succeed(name)
}

export const update = (
  model: Model,
  message: Message,
  known: ReadonlyArray<RemoteEngines.RemoteEngine> = [],
): Return =>
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
        ? modifyFields(model, {
            addProject: () => AddFlow.Closed(),
            folders: () => FolderBrowser.Closed(),
          })
        : model,
    }),
    OpenedFolders: () =>
      AddFlow.match(model.addProject, {
        Editing: ({ form }) => browse(model, decodeText(form.path.trim())),
        Closed: () => ({ model }),
        Adding: () => ({ model }),
      }),
    RequestedFolders: ({ path }) => browse(model, path),
    SucceededFolders: ({ path, listing }) => ({
      model: answerFolders(model, path, FolderBrowser.Shown({ listing })),
    }),
    FailedFolders: ({ path, reason }) => ({
      model: answerFolders(model, path, FolderBrowser.Failed({ path, reason })),
    }),
    ChoseFolder: ({ path }) => ({
      model: AddFlow.guards.Editing(model.addProject)
        ? modifyFields(
            editForm(model, form => ({ ...form, path })),
            {
              folders: () => FolderBrowser.Closed(),
            },
          )
        : model,
    }),
    ClosedFolders: () => ({
      model: modifyFields(model, { folders: () => FolderBrowser.Closed() }),
    }),
    SucceededAddProject: ({ project }) => ({
      model: modifyFields(model, {
        addProject: () => AddFlow.Closed(),
        folders: () => FolderBrowser.Closed(),
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

    OpenedAddEngine: () => ({
      model: busy(model.engineSetup)
        ? model
        : modifyFields(model, {
            engineSetup: () =>
              EngineSetup.Editing({
                destination: '',
                name: '',
                problem: Option.none(),
              }),
          }),
    }),
    ChangedEngineDestination: ({ destination }) => ({
      model: editEngine(model, editing => ({ ...editing, destination })),
    }),
    ChangedEngineName: ({ name }) => ({
      model: editEngine(model, editing => ({ ...editing, name })),
    }),
    SubmittedAddEngine: () =>
      EngineSetup.match(model.engineSetup, {
        Editing: (editing): Return => {
          const refuse = (problem: string): Return => ({
            model: modifyFields(model, {
              engineSetup: () =>
                EngineSetup.Editing({
                  ...editing,
                  problem: Option.some(problem),
                }),
            }),
          })
          return Option.match(decodeDestination(editing.destination.trim()), {
            onNone: () =>
              refuse(
                'Give the host’s SSH destination: user@host, or a host of your ~/.ssh/config.',
              ),
            onSome: destination =>
              Result.match(
                engineName(
                  editing.name,
                  {
                    reachedThere: address =>
                      EngineAddress.guards.Ssh(address) &&
                      address.destination === destination,
                    fallback: defaultEngineName(destination),
                  },
                  known,
                ),
                {
                  onFailure: refuse,
                  onSuccess: name =>
                    startCheck(
                      model,
                      EngineHost.cases.Ssh.make({ destination }),
                      Option.some(name),
                    ),
                },
              ),
          })
        },
        EditingTls: (editing): Return => {
          const refuse = (problem: string): Return => ({
            model: modifyFields(model, {
              engineSetup: () =>
                EngineSetup.EditingTls({
                  ...editing,
                  problem: Option.some(problem),
                }),
            }),
          })
          const token = Redacted.make(Redacted.value(editing.token).trim())
          return Option.match(parseTlsEndpoint(editing.address), {
            onNone: () =>
              refuse(
                'Give the engine’s TLS address, host:port, as fabrica engine status prints it on its host.',
              ),
            onSome: endpoint =>
              Redacted.value(token) === ''
                ? refuse(
                    'Give a pairing token: fabrica token create makes one on the engine’s host.',
                  )
                : Result.match(
                    engineName(
                      editing.name,
                      {
                        reachedThere: address =>
                          EngineAddress.guards.Tls(address) &&
                          sameEndpoint(address, endpoint),
                        fallback: endpoint.host,
                      },
                      known,
                    ),
                    {
                      onFailure: refuse,
                      onSuccess: name =>
                        startPairing(model, { name, endpoint, token }),
                    },
                  ),
          })
        },
        Closed: () => ({ model }),
        Wsl: () => ({ model }),
        Pairing: () => ({ model }),
        Running: () => ({ model }),
      }),
    RequestedEngineUpdate: () =>
      busy(model.engineSetup)
        ? { model }
        : startCheck(model, EngineHost.cases.Local.make({}), Option.none()),
    RequestedRemoteUpdate: ({ name, destination }) =>
      busy(model.engineSetup)
        ? { model }
        : startCheck(
            model,
            EngineHost.cases.Ssh.make({ destination }),
            Option.some(name),
          ),
    RetriedRemote: () => ({ model }),
    CompletedEngineCheck: ({ host, answer }) => ({
      model: stepSetup(model, host, step =>
        SetupStep.guards.Checking(step)
          ? Option.some(
              CheckAnswer.match(answer, {
                Checked: ({ check }): SetupStep => SetupStep.Checked({ check }),
                Failed: ({ reason }): SetupStep => SetupStep.Failed({ reason }),
              }),
            )
          : Option.none(),
      ),
    }),
    ConsentedInstall: () =>
      EngineSetup.match(model.engineSetup, {
        Running: (running): Return =>
          SetupStep.match(running.step, {
            Checked: ({ check }): Return =>
              Option.match(consentFor(check.plan), {
                onNone: () => ({ model }),
                onSome: consent => ({
                  model: modifyFields(model, {
                    engineSetup: () =>
                      EngineSetup.Running({
                        ...running,
                        step: SetupStep.Installing({ consent }),
                      }),
                  }),
                  commands: [InstallEngine({ host: running.host, consent })],
                }),
              }),
            Checking: () => ({ model }),
            Installing: () => ({ model }),
            Installed: () => ({ model }),
            Failed: () => ({ model }),
          }),
        Closed: () => ({ model }),
        Editing: () => ({ model }),
        EditingTls: () => ({ model }),
        Pairing: () => ({ model }),
        Wsl: () => ({ model }),
      }),
    CompletedEngineInstall: ({ host, answer }) => ({
      model: stepSetup(model, host, step =>
        SetupStep.guards.Installing(step)
          ? Option.some(
              InstallAnswer.match(answer, {
                Installed: ({ installed }): SetupStep =>
                  SetupStep.Installed({ installed }),
                Failed: ({ reason }): SetupStep => SetupStep.Failed({ reason }),
              }),
            )
          : Option.none(),
      ),
    }),
    RetriedEngineCheck: () =>
      EngineSetup.guards.Running(model.engineSetup) && !busy(model.engineSetup)
        ? startCheck(model, model.engineSetup.host, model.engineSetup.name)
        : { model },
    ClosedEngineSetup: () => ({
      model: busy(model.engineSetup)
        ? model
        : modifyFields(model, { engineSetup: () => EngineSetup.Closed() }),
    }),
    ChoseWslEngine: () =>
      busy(model.engineSetup) || EngineSetup.guards.Closed(model.engineSetup)
        ? { model }
        : {
            model: modifyFields(model, {
              engineSetup: () => EngineSetup.Wsl({ step: WslStep.Searching() }),
            }),
            commands: [FindWsl()],
          },
    ChoseSshEngine: () => ({
      model:
        (EngineSetup.guards.Wsl(model.engineSetup) ||
          EngineSetup.guards.EditingTls(model.engineSetup)) &&
        !busy(model.engineSetup)
          ? modifyFields(model, {
              engineSetup: () =>
                EngineSetup.Editing({
                  destination: '',
                  name: '',
                  problem: Option.none(),
                }),
            })
          : model,
    }),
    CompletedWslSearch: ({ search }) => ({
      model: stepWsl(model, step =>
        WslStep.guards.Searching(step)
          ? Option.some(WslStep.Searched({ search }))
          : Option.none(),
      ),
    }),
    RequestedUbuntuInstall: () =>
      Option.exists(foundDistro(model.engineSetup), WslSearch.guards.None)
        ? {
            model: modifyFields(model, {
              engineSetup: () =>
                EngineSetup.Wsl({ step: WslStep.InstallingUbuntu() }),
            }),
            commands: [InstallUbuntu()],
          }
        : { model },
    CompletedUbuntuInstall: ({ outcome }) => ({
      model: stepWsl(model, step =>
        WslStep.guards.InstallingUbuntu(step)
          ? Option.some(
              UbuntuInstall.match(outcome, {
                Ready: ({ distro }): WslStep =>
                  WslStep.Searched({
                    search: WslSearch.cases.Found.make({ distro }),
                  }),
                Unfinished: ({ reason }): WslStep =>
                  WslStep.UbuntuUnfinished({ reason }),
              }),
            )
          : Option.none(),
      ),
    }),
    ChoseTlsEngine: () => ({
      model:
        (EngineSetup.guards.Editing(model.engineSetup) ||
          EngineSetup.guards.Wsl(model.engineSetup)) &&
        !busy(model.engineSetup)
          ? modifyFields(model, {
              engineSetup: () =>
                EngineSetup.EditingTls({
                  address: '',
                  token: Redacted.make(''),
                  name: '',
                  problem: Option.none(),
                }),
            })
          : model,
    }),
    ChangedEngineAddress: ({ address }) => ({
      model: editEngine(
        model,
        typed => typed,
        typed => ({ ...typed, address }),
      ),
    }),
    ChangedEngineToken: ({ token }) => ({
      model: editEngine(
        model,
        typed => typed,
        typed => ({ ...typed, token }),
      ),
    }),
    CompletedFingerprintRead: ({ endpoint, answer }) => ({
      model: stepPairing(model, endpoint, step =>
        PairStep.guards.Reading(step)
          ? Option.some(
              FingerprintAnswer.match(answer, {
                Presented: ({ fingerprint }): PairStep =>
                  PairStep.Read({ fingerprint }),
                Failed: ({ reason }): PairStep => PairStep.Failed({ reason }),
              }),
            )
          : Option.none(),
      ),
    }),
    AcceptedFingerprint: () =>
      EngineSetup.guards.Pairing(model.engineSetup) &&
      PairStep.guards.Read(model.engineSetup.step)
        ? {
            model: modifyFields(model, {
              engineSetup: setup =>
                EngineSetup.guards.Pairing(setup) &&
                PairStep.guards.Read(setup.step)
                  ? EngineSetup.Pairing({
                      ...setup,
                      step: PairStep.Pairing({
                        fingerprint: setup.step.fingerprint,
                      }),
                    })
                  : setup,
            }),
            commands: [
              PairEngine({
                name: model.engineSetup.name,
                endpoint: model.engineSetup.endpoint,
                fingerprint: model.engineSetup.step.fingerprint,
                token: model.engineSetup.token,
              }),
            ],
          }
        : { model },
    RetriedFingerprintRead: () =>
      EngineSetup.guards.Pairing(model.engineSetup) &&
      PairStep.guards.Failed(model.engineSetup.step)
        ? startPairing(model, {
            name: model.engineSetup.name,
            endpoint: model.engineSetup.endpoint,
            token: model.engineSetup.token,
          })
        : { model },
    CompletedPairing: ({ name, answer }) => ({
      model:
        EngineSetup.guards.Pairing(model.engineSetup) &&
        model.engineSetup.name === name
          ? stepPairing(model, model.engineSetup.endpoint, step =>
              PairStep.guards.Pairing(step)
                ? Option.some(
                    PairAnswer.match(answer, {
                      Paired: (): PairStep =>
                        PairStep.Paired({ fingerprint: step.fingerprint }),
                      Failed: ({ reason }): PairStep =>
                        PairStep.Failed({ reason }),
                    }),
                  )
                : Option.none(),
            )
          : model,
    }),
    RequestedRepair: ({ name, endpoint }) => ({
      model: busy(model.engineSetup)
        ? model
        : modifyFields(model, {
            engineSetup: () =>
              EngineSetup.EditingTls({
                address: tlsEndpointText(endpoint),
                token: Redacted.make(''),
                name,
                problem: Option.none(),
              }),
          }),
    }),
    RequestedWslCheck: () =>
      Option.match(
        Option.filter(foundDistro(model.engineSetup), WslSearch.guards.Found),
        {
          onNone: () => ({ model }),
          onSome: ({ distro }) =>
            startCheck(
              model,
              EngineHost.cases.Wsl.make({ distro }),
              Option.none(),
            ),
        },
      ),
  })

// The view: the handoff's panel, card and list language (§18.2), since the handoff draws no screen
// but the console.

/**
 * What the frame gives the screen: the connection, each known engine's projects, as the sidebar holds
 * them, where the app runs, since only the Windows app adds engines in WSL2, and the known engines on
 * other hosts with their connections.
 */
export interface ViewInputs {
  readonly connection: Connection
  readonly engines: ReadonlyArray<EngineProjects>
  readonly platform: Platform
  readonly remotes: RemoteEngines.Model
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
    Stopped: () => ({ word: 'Refused', tone: 'text-c3' }),
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
    Stopped: () => Option.none<string>(),
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
      updateOffer(
        model,
        inputs.connection,
        Option.some(Message.RequestedEngineUpdate()),
        h,
      ),
      loginServiceView(model, h),
    ],
  )
}

/** Where a known engine is reached, in words. */
export const addressText = (address: EngineAddress): string =>
  EngineAddress.match(address, {
    Local: () => 'This machine',
    Ssh: ({ destination }) => destination,
    Wsl: ({ distro }) => `WSL ${distro}`,
    Tls: endpoint => tlsEndpointText(endpoint),
  })

/** A known engine on another host: where it is, its connection's state, and what it offers. */
const remoteCard = (
  model: Model,
  remote: RemoteEngines.RemoteEngine,
  h: HtmlBuilder<Message>,
): Html => {
  const state = connectionWord(remote.connection)
  const protocol = Connection.match(remote.connection, {
    Connecting: () => Option.none<string>(),
    Up: ({ release, protocol }) =>
      Option.some(`${release} · protocol ${protocol}`),
    Down: () => Option.none<string>(),
    Failed: () => Option.none<string>(),
    Stopped: () => Option.none<string>(),
    Refused: ({ engine }) => Option.some(`protocol ${engine}`),
  })
  const requestUpdate = EngineAddress.guards.Ssh(remote.address)
    ? Option.some(
        Message.RequestedRemoteUpdate({
          name: remote.name,
          destination: remote.address.destination,
        }),
      )
    : Option.none()
  return h.article(
    [h.AriaLabel(`Engine ${remote.name}`), h.Class(card), h.Style(cardStyle)],
    [
      h.div(
        [h.Class('flex items-center gap-10')],
        [
          h.h3([h.Class('text-sm font-extrabold')], [remote.name]),
          h.span(
            [h.Class('font-mono text-xs text-muted')],
            [addressText(remote.address)],
          ),
          ...Option.match(protocol, {
            onNone: () => [],
            onSome: text => [
              h.span([h.Class('font-mono text-xs text-muted')], [text]),
            ],
          }),
          h.span(
            [
              h.DataAttribute('engine-state', remote.connection._tag),
              h.Class(`ml-auto text-xs font-bold ${state.tone}`),
            ],
            [state.word],
          ),
        ],
      ),
      Connection.match(remote.connection, {
        Connecting: () => h.empty,
        Up: () => h.empty,
        Down: () => h.empty,
        Failed: ({ reason }) =>
          h.p(
            [h.Class('text-xs text-muted')],
            [`It couldn't be reached: ${reason}. Trying again…`],
          ),
        Stopped: ({ reason }) =>
          h.div(
            [h.Class('flex items-center gap-10')],
            [
              problemLine(reason, h),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.RetriedRemote({ name: remote.name })),
                  h.Class(quietButton),
                ],
                ['Try again'],
              ),
              // Its certificate changed, or its token was refused: paired again, with a new token.
              EngineAddress.guards.Tls(remote.address)
                ? h.button(
                    [
                      h.Type('button'),
                      h.OnClick(
                        Message.RequestedRepair({
                          name: remote.name,
                          endpoint: {
                            host: remote.address.host,
                            port: remote.address.port,
                          },
                        }),
                      ),
                      h.Disabled(busy(model.engineSetup)),
                      h.Class(quietButton),
                    ],
                    ['Pair again'],
                  )
                : h.empty,
            ],
          ),
        Refused: () => updateOffer(model, remote.connection, requestUpdate, h),
      }),
    ],
  )
}

/**
 * What the card offers an engine that refused the app at connect (§8.4): its update, through
 * `requestUpdate` where the app can update it, or the app's.
 */
const updateOffer = (
  model: Model,
  connection: Connection,
  requestUpdate: Option.Option<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Connection.match(connection, {
    Refused: ({ client, engine, update }) =>
      update === 'client'
        ? problemLine(
            `The engine speaks protocol ${engine}, newer than this app's ${client}: update the app to reach it.`,
            h,
          )
        : Option.match(requestUpdate, {
            onNone: () =>
              problemLine(
                `The engine speaks protocol ${engine}, older than this app's ${client}: update it on its host.`,
                h,
              ),
            onSome: request =>
              h.div(
                [h.Class('flex items-center gap-10')],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(request),
                      h.Disabled(busy(model.engineSetup)),
                      h.Class(primaryButton),
                    ],
                    ['Update the engine'],
                  ),
                  h.span(
                    [h.Class('text-xs text-c3')],
                    [
                      `The engine speaks protocol ${engine}, older than this app's ${client}: updating it winds its runs down first.`,
                    ],
                  ),
                ],
              ),
          }),
    Connecting: () => h.empty,
    Up: () => h.empty,
    Down: () => h.empty,
    Failed: () => h.empty,
    Stopped: () => h.empty,
  })

/** The host, as the setup names it. */
export const hostName = (host: EngineHost): string =>
  EngineHost.match(host, {
    Local: () => 'this machine',
    Ssh: ({ destination }) => destination,
    Wsl: ({ distro }) => `WSL ${distro}`,
  })

/** What the check proposes, in words. */
export const planText = (plan: InstallPlan): string =>
  InstallPlan.match(plan, {
    Install: ({ to }) =>
      `No engine is there. Install fabrica ${to}, and run it as a login service?`,
    Update: ({ from, to }) =>
      `fabrica ${from} is there. Update it to ${to}? Its runs are wound down before it restarts.`,
    Current: ({ version }) =>
      `fabrica ${version} is there already: there is nothing to install.`,
    Newer: ({ there, offered }) =>
      `fabrica ${there} is there, later than this app's ${offered}: update the app to reach it.`,
  })

/** The button that agrees to the plan: none for a plan that installs nothing. */
const consentLabel = (consent: InstallConsent): string =>
  InstallConsent.match(consent, {
    Install: ({ to }) => `Install ${to}`,
    Update: ({ to }) => `Update to ${to}`,
  })

const closeButton = (label: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClosedEngineSetup()),
      h.Class(quietButton),
    ],
    [label],
  )

/** Where Add engine adds the engine: over SSH, over TLS with a pairing token (§9.3), or in WSL2 (§7.6). */
type EnginePlace = 'ssh' | 'tls' | 'wsl'

const choosePlace: Record<EnginePlace, Message> = {
  ssh: Message.ChoseSshEngine(),
  tls: Message.ChoseTlsEngine(),
  wsl: Message.ChoseWslEngine(),
}

const placeButton = (
  place: EnginePlace,
  chosen: EnginePlace,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(place === chosen ? 'true' : 'false'),
      h.OnClick(choosePlace[place]),
      h.Class(
        `rounded-button border px-10 py-4 text-xs ${place === chosen ? 'border-c1 font-bold' : 'border-line text-muted'}`,
      ),
    ],
    [label],
  )

/** The choice between an engine over SSH, one over TLS, and, on Windows, one in WSL2. */
const placeChoice = (
  chosen: EnginePlace,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('group'), h.AriaLabel('Add an engine'), h.Class('flex gap-8')],
    [
      placeButton('ssh', chosen, 'Over SSH', h),
      placeButton('tls', chosen, 'Over TLS', h),
      platform === 'win32' ? placeButton('wsl', chosen, 'In WSL2', h) : h.empty,
    ],
  )

const addEngineForm = (
  { destination, name }: EngineForm,
  problem: Option.Option<string>,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.AriaLabel('Add engine'),
      h.OnSubmit(Message.SubmittedAddEngine()),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      placeChoice('ssh', platform, h),
      labelled(
        'add-engine-destination',
        'SSH destination',
        h.input([
          h.Id('add-engine-destination'),
          h.Type('text'),
          h.Value(destination),
          h.Placeholder('me@build-box'),
          h.OnInput(destination =>
            Message.ChangedEngineDestination({ destination }),
          ),
          h.Class(`font-mono ${field}`),
        ]),
        h,
      ),
      h.p(
        [h.Class('text-xs text-muted')],
        [
          'user@host, or a host of your ~/.ssh/config, reached with your own keys. The host is checked first; nothing is installed until you agree.',
        ],
      ),
      labelled(
        'add-engine-name',
        'Name',
        h.input([
          h.Id('add-engine-name'),
          h.Type('text'),
          h.Value(name),
          h.Placeholder('its host’s, where left empty'),
          h.OnInput(name => Message.ChangedEngineName({ name })),
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
            [h.Type('submit'), h.Class(primaryButton)],
            ['Check the host'],
          ),
          closeButton('Cancel', h),
        ],
      ),
    ],
  )

/** Add engine over TLS: the engine's address, a pairing token and its name (§9.3). */
const tlsForm = (
  { address, token, name }: TlsForm,
  problem: Option.Option<string>,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.AriaLabel('Add engine over TLS'),
      h.OnSubmit(Message.SubmittedAddEngine()),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      placeChoice('tls', platform, h),
      labelled(
        'add-engine-address',
        'TLS address',
        h.input([
          h.Id('add-engine-address'),
          h.Type('text'),
          h.Value(address),
          h.Placeholder('build-box:8443'),
          h.OnInput(address => Message.ChangedEngineAddress({ address })),
          h.Class(`font-mono ${field}`),
        ]),
        h,
      ),
      labelled(
        'add-engine-token',
        'Pairing token',
        h.input([
          h.Id('add-engine-token'),
          h.Type('password'),
          h.Value(Redacted.value(token)),
          h.Autocomplete('off'),
          h.OnInput(token =>
            Message.ChangedEngineToken({ token: Redacted.make(token) }),
          ),
          h.Class(`font-mono ${field}`),
        ]),
        h,
      ),
      h.p(
        [h.Class('text-xs text-muted')],
        [
          'Where the engine listens over TLS, as fabrica engine status prints it on its host, and a token fabrica token create made there. The app reads the engine’s certificate first and shows you its fingerprint; nothing is kept until you accept it.',
        ],
      ),
      labelled(
        'add-engine-name',
        'Name',
        h.input([
          h.Id('add-engine-name'),
          h.Type('text'),
          h.Value(name),
          h.Placeholder('its host’s, where left empty'),
          h.OnInput(name => Message.ChangedEngineName({ name })),
          h.Class(field),
        ]),
        h,
      ),
      Option.match(problem, {
        onNone: () => h.empty,
        onSome: text => problemLine(text, h),
      }),
      actions(
        [
          h.button(
            [h.Type('submit'), h.Class(primaryButton)],
            ['Read its certificate'],
          ),
          closeButton('Cancel', h),
        ],
        h,
      ),
    ],
  )

/** The fingerprint read, as the user compares it with the one the engine's host prints. */
const fingerprintLine = (fingerprint: string, h: HtmlBuilder<Message>): Html =>
  h.p(
    [
      h.AriaLabel('Certificate fingerprint'),
      h.Class('break-all font-mono text-xs'),
    ],
    [`SHA-256 ${fingerprint}`],
  )

/** Pairing with the engine named `name` at `endpoint`: its certificate read, accepted, paired. */
const pairingView = (
  name: EngineName,
  endpoint: TlsEndpoint,
  step: PairStep,
  h: HtmlBuilder<Message>,
): Html => {
  const at = tlsEndpointText(endpoint)
  return h.section(
    [h.AriaLabel(`Engine at ${at}`), h.Class(card), h.Style(cardStyle)],
    [
      h.h3([h.Class('text-sm font-extrabold')], [`${name} at ${at}`]),
      PairStep.match(step, {
        Reading: () =>
          statusLine(
            `Reading the certificate the engine at ${at} presents…`,
            h,
          ),
        Read: ({ fingerprint }) =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [
              h.p(
                [h.Class('text-sm')],
                [`The engine at ${at} presents this certificate:`],
              ),
              fingerprintLine(fingerprint, h),
              h.p(
                [h.Class('text-xs text-c3')],
                [
                  'Compare it with the fingerprint fabrica engine status prints on the engine’s host, and accept it only if they are the same: the app will reach this engine only while it presents this certificate.',
                ],
              ),
              actions(
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.AcceptedFingerprint()),
                      h.Class(primaryButton),
                    ],
                    ['Accept and pair'],
                  ),
                  closeButton('Cancel', h),
                ],
                h,
              ),
            ],
          ),
        Pairing: ({ fingerprint }) =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [fingerprintLine(fingerprint, h), statusLine('Pairing…', h)],
          ),
        Paired: ({ fingerprint }) =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [
              h.p(
                [h.Role('status'), h.Class('text-sm text-c4')],
                [
                  `Paired with ${name}: the app reaches it at ${at} while it presents this certificate, and keeps its token once it answers.`,
                ],
              ),
              fingerprintLine(fingerprint, h),
              actions([closeButton('Close', h)], h),
            ],
          ),
        Failed: ({ reason }) =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [
              problemLine(reason, h),
              actions(
                [
                  quietAction(
                    'Read it again',
                    Message.RetriedFingerprintRead(),
                    h,
                  ),
                  closeButton('Close', h),
                ],
                h,
              ),
            ],
          ),
      }),
    ],
  )
}

const checkView = (check: HostCheck, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.dl(
        [
          h.Class('grid gap-10'),
          h.Style({ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }),
        ],
        [fact('Host', check.host, h), fact('Engine target', check.target, h)],
      ),
      ...check.notes.map(note => h.p([h.Class('text-xs text-c2')], [note])),
      h.p([h.Class('text-sm')], [planText(check.plan)]),
      h.div(
        [h.Class('flex items-center gap-8')],
        Option.match(consentFor(check.plan), {
          onNone: () => [closeButton('Close', h)],
          onSome: consent => [
            h.button(
              [
                h.Type('button'),
                h.OnClick(Message.ConsentedInstall()),
                h.Class(primaryButton),
              ],
              [consentLabel(consent)],
            ),
            closeButton('Cancel', h),
          ],
        }),
      ),
    ],
  )

const stepView = (
  host: EngineHost,
  step: SetupStep,
  h: HtmlBuilder<Message>,
): Html =>
  SetupStep.match(step, {
    Checking: () =>
      h.p(
        [h.Role('status'), h.Class('text-xs text-muted')],
        [`Checking ${hostName(host)}…`],
      ),
    Checked: ({ check }) => checkView(check, h),
    Installing: ({ consent }) =>
      h.p(
        [h.Role('status'), h.Class('text-xs text-muted')],
        [
          InstallConsent.match(consent, {
            Install: ({ to }) => `Installing fabrica ${to}…`,
            Update: ({ to }) =>
              `Updating to fabrica ${to}, once its runs are wound down…`,
          }),
        ],
      ),
    Installed: ({ installed }) =>
      h.div(
        [h.Class('flex flex-col gap-8')],
        [
          h.p(
            [h.Role('status'), h.Class('text-sm text-c4')],
            [
              `Installed fabrica ${installed.version} on ${hostName(host)}: ${installed.launcher}`,
            ],
          ),
          installed.service === ''
            ? h.empty
            : h.pre(
                [h.Class('whitespace-pre-wrap font-mono text-xs text-muted')],
                [installed.service],
              ),
          h.div(
            [h.Class('flex items-center gap-8')],
            [closeButton('Close', h)],
          ),
        ],
      ),
    Failed: ({ reason }) =>
      h.div(
        [h.Class('flex flex-col gap-8')],
        [
          problemLine(reason, h),
          h.div(
            [h.Class('flex items-center gap-8')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.RetriedEngineCheck()),
                  h.Class(quietButton),
                ],
                ['Check again'],
              ),
              closeButton('Close', h),
            ],
          ),
        ],
      ),
  })

const statusLine = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('status'), h.Class('text-xs text-muted')], [text])

const quietAction = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [h.Type('button'), h.OnClick(message), h.Class(quietButton)],
    [label],
  )

const primaryAction = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [h.Type('button'), h.OnClick(message), h.Class(primaryButton)],
    [label],
  )

const actions = (buttons: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex items-center gap-8')], [...buttons])

/** What the search for a WSL2 distribution found, and what can be done with it. */
const wslSearchView = (search: WslSearch, h: HtmlBuilder<Message>): Html =>
  WslSearch.match(search, {
    Found: ({ distro }) =>
      h.div(
        [h.Class('flex flex-col gap-8')],
        [
          h.p(
            [h.Class('text-sm')],
            [
              `The engine runs in ${distro}, WSL's default WSL2 distribution or else its first. It is checked first; nothing is installed until you agree.`,
            ],
          ),
          actions(
            [
              primaryAction(`Check ${distro}`, Message.RequestedWslCheck(), h),
              closeButton('Cancel', h),
            ],
            h,
          ),
        ],
      ),
    None: ({ wsl1 }) =>
      h.div(
        [h.Class('flex flex-col gap-8')],
        [
          h.p(
            [h.Class('text-sm')],
            [
              'WSL has no WSL2 distribution to run the engine in. Install Ubuntu? WSL installs it, and itself where it isn’t there, in a window of its own, where it asks for a user name and password; Windows may ask to restart.',
            ],
          ),
          wsl1.length === 0
            ? h.empty
            : h.p(
                [h.Class('text-xs text-c2')],
                [
                  `${wsl1.join(', ')} ${wsl1.length === 1 ? 'runs' : 'run'} WSL 1, where the engine can’t run.`,
                ],
              ),
          actions(
            [
              primaryAction(
                'Install Ubuntu',
                Message.RequestedUbuntuInstall(),
                h,
              ),
              closeButton('Cancel', h),
            ],
            h,
          ),
        ],
      ),
    Unavailable: ({ reason }) =>
      h.div(
        [h.Class('flex flex-col gap-8')],
        [
          problemLine(`WSL can’t run here: ${reason}`, h),
          actions(
            [
              quietAction('Look again', Message.ChoseWslEngine(), h),
              closeButton('Close', h),
            ],
            h,
          ),
        ],
      ),
  })

/** Add engine in WSL2: the distribution looked for, Ubuntu installed where there is none (§7.6). */
const wslView = (
  step: WslStep,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel('Engine in WSL2'), h.Class(card), h.Style(cardStyle)],
    [
      placeChoice('wsl', platform, h),
      WslStep.match(step, {
        Searching: () => statusLine('Looking for a WSL2 distribution…', h),
        Searched: ({ search }) => wslSearchView(search, h),
        InstallingUbuntu: () =>
          statusLine('Installing Ubuntu: finish its setup in WSL’s window…', h),
        UbuntuUnfinished: ({ reason }) =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            [
              problemLine(reason, h),
              actions(
                [
                  quietAction('Look again', Message.ChoseWslEngine(), h),
                  closeButton('Close', h),
                ],
                h,
              ),
            ],
          ),
      }),
    ],
  )

/** Add engine's form, or the setup under way on a host. */
const setupView = (
  model: Model,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  EngineSetup.match(model.engineSetup, {
    Closed: () => h.empty,
    Editing: ({ destination, name, problem }) =>
      addEngineForm({ destination, name }, problem, platform, h),
    EditingTls: ({ address, token, name, problem }) =>
      tlsForm({ address, token, name }, problem, platform, h),
    Pairing: ({ name, endpoint, step }) => pairingView(name, endpoint, step, h),
    Wsl: ({ step }) => wslView(step, platform, h),
    Running: ({ host, step }) =>
      h.section(
        [
          h.AriaLabel(`Engine on ${hostName(host)}`),
          h.Class(card),
          h.Style(cardStyle),
        ],
        [
          h.h3(
            [h.Class('text-sm font-extrabold')],
            [`Engine on ${hostName(host)}`],
          ),
          stepView(host, step, h),
        ],
      ),
  })

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

/** The browser's buttons that move it: home, and up where the folder shown has a parent. */
const folderMoves = (
  parent: Option.Option<string>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...Option.match(parent, {
    onNone: () => [],
    onSome: path => [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.RequestedFolders({ path: Option.some(path) })),
          h.Class(quietButton),
        ],
        ['Up'],
      ),
    ],
  }),
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.RequestedFolders({ path: Option.none() })),
      h.Class(quietButton),
    ],
    ['Home'],
  ),
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClosedFolders()),
      h.Class(`ml-auto ${quietButton}`),
    ],
    ['Close'],
  ),
]

/** A folder shown: its name opens it; a checkout is marked, with the button that chooses it. */
const folderRow = (folder: HostFolder, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    folder.path,
    [h.Class('flex items-center gap-8 text-sm')],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(`Open ${folder.name}`),
          h.OnClick(
            Message.RequestedFolders({ path: Option.some(folder.path) }),
          ),
          h.Class('min-w-0 truncate text-left font-mono'),
        ],
        [`${folder.name}/`],
      ),
      folder.checkout
        ? h.span([h.Class('text-xs text-c4')], ['git checkout'])
        : h.empty,
      folder.checkout
        ? h.button(
            [
              h.Type('button'),
              h.AriaLabel(`Choose ${folder.name}`),
              h.OnClick(Message.ChoseFolder({ path: folder.path })),
              h.Class(`ml-auto ${quietButton}`),
            ],
            ['Choose'],
          )
        : h.empty,
    ],
  )

/** The engine host's folders, as the browser shows them. */
const folderBrowser = (
  folders: FolderBrowser,
  h: HtmlBuilder<Message>,
): Html => {
  const browser = (children: ReadonlyArray<Html>): Html =>
    h.section(
      [
        h.AriaLabel(`Folders on ${localEngineName}`),
        h.Class('flex flex-col gap-8 rounded-button border border-line'),
        h.Style({ padding: '8px 10px' }),
      ],
      children,
    )
  return FolderBrowser.match(folders, {
    Closed: () => h.empty,
    Loading: () =>
      browser([
        h.p(
          [h.Role('status'), h.Class('text-xs text-muted')],
          ['Listing the folders…'],
        ),
      ]),
    Failed: ({ reason }) =>
      browser([
        problemLine(`Couldn't list the folder: ${reason}`, h),
        h.div(
          [h.Class('flex items-center gap-8')],
          folderMoves(Option.none(), h),
        ),
      ]),
    Shown: ({ listing }) =>
      browser([
        h.div(
          [h.Class('flex items-center gap-8')],
          [
            h.span(
              [h.Class('min-w-0 truncate font-mono text-xs')],
              [listing.path],
            ),
            listing.checkout
              ? h.span([h.Class('text-xs text-c4')], ['git checkout'])
              : h.empty,
          ],
        ),
        h.div(
          [h.Class('flex items-center gap-8')],
          [
            h.button(
              [
                h.Type('button'),
                h.OnClick(Message.ChoseFolder({ path: listing.path })),
                h.Class(quietButton),
              ],
              ['Choose this folder'],
            ),
            ...folderMoves(listing.parent, h),
          ],
        ),
        listing.folders.length === 0
          ? h.p([h.Class('text-xs text-muted')], ['No folders here.'])
          : h.ul(
              [
                h.AriaLabel(`Folders in ${listing.path}`),
                h.Class('flex flex-col gap-4 overflow-auto'),
                h.Style({ maxHeight: '240px' }),
              ],
              listing.folders.map(folder => folderRow(folder, h)),
            ),
      ]),
  })
}

const addProjectForm = (
  form: AddForm,
  problem: Option.Option<string>,
  adding: boolean,
  folders: FolderBrowser,
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
            h.div(
              [h.Class('flex items-center gap-8')],
              [
                h.input([
                  h.Id('add-project-path'),
                  h.Type('text'),
                  h.Value(form.path),
                  h.Placeholder('/Users/me/src/app'),
                  h.OnInput(path => Message.ChangedProjectPath({ path })),
                  h.Disabled(adding),
                  h.Class(`min-w-0 flex-1 font-mono ${field}`),
                ]),
                h.button(
                  [
                    h.Type('button'),
                    h.OnClick(Message.OpenedFolders()),
                    h.Disabled(adding),
                    h.Class(quietButton),
                  ],
                  ['Browse…'],
                ),
              ],
            ),
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
      form.kind === 'path' ? driveWarning(form.path.trim(), h) : h.empty,
      form.kind === 'path' && !adding ? folderBrowser(folders, h) : h.empty,
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
      driveWarning(project.path, h),
      setUpLine,
    ],
  )
}

/**
 * The warning about a checkout at `path` on a Windows drive, as a WSL2 engine sees it under
 * `/mnt/<letter>` (§7.6): none elsewhere.
 */
const driveWarning = (path: string, h: HtmlBuilder<Message>): Html =>
  Option.match(windowsDriveWarning(path), {
    onNone: () => h.empty,
    onSome: text => h.p([h.Class('text-xs text-c2')], [text]),
  })

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
        Editing: ({ form, problem }) =>
          addProjectForm(form, problem, false, model.folders, h),
        Adding: ({ form }) =>
          addProjectForm(form, Option.none(), true, model.folders, h),
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
          h.div(
            [h.Class('flex items-center gap-10')],
            [
              h.h2([h.Class('text-sm font-extrabold')], ['Engines']),
              EngineSetup.guards.Closed(model.engineSetup)
                ? h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.OpenedAddEngine()),
                      h.Class(`ml-auto ${primaryButton}`),
                    ],
                    ['+ Add engine'],
                  )
                : h.empty,
            ],
          ),
          engineCard(model, inputs, h),
          ...inputs.remotes.engines.map(remote => remoteCard(model, remote, h)),
          Option.match(inputs.remotes.problem, {
            onNone: () => h.empty,
            onSome: text => problemLine(text, h),
          }),
          setupView(model, inputs.platform, h),
        ],
      ),
      projectsView(model, inputs, h),
      credentialsView(model, h),
    ],
  ),
)
