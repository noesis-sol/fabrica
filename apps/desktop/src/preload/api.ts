import { Option, Schema } from 'effect'

import {
  CheckAnswer,
  EngineHost,
  FingerprintAnswer,
  InstallAnswer,
  InstallConsent,
  KeepAnswer,
  KnownEngine,
  KnownEnginesAnswer,
  PairAnswer,
  PairRequest,
  SshPromptAnswer,
  SshPromptEvent,
  type SshPromptsApi,
  TlsEndpoint,
  UbuntuInstall,
  WslSearch,
  sshPromptsMember,
} from '@fabrica/client'
import { ReleaseVersion } from '@fabrica/contracts'
import {
  ServiceInstall,
  checkEngineMethod,
  connectEngineMethod,
  findWslMethod,
  installEngineMethod,
  installLoginServiceMethod,
  installUbuntuMethod,
  keepEngineMethod,
  knownEnginesMethod,
  pairEngineMethod,
  readFingerprintMethod,
} from '@fabrica/ui/host'
import {
  DesktopNotification,
  NotificationTarget,
  type NotificationsApi,
} from '@fabrica/ui/notify'
import {
  EnginePortRequest,
  enginePortMessage,
  remoteEnginePortMessage,
} from '@fabrica/ui/port'
import { Theme } from '@fabrica/ui/theme'

// The preload's API (spec §20.1): what the page may ask of main, and no more. The renderer is treated
// as an untrusted web page, so every value crossing is decoded with these schemas on both sides: by
// the preload, from the page and from main, and by main, from the preload. The window controls, the
// folder picker, the app's version, the update status, the system notifications and their clicks
// (§18.5), installing the local engine's login service, checking a host for an engine and installing it
// there (§9.2), finding a WSL2 distribution to run it in and installing Ubuntu where there is none
// (§7.6), what ssh asks as it connects and the page's answers (§9.1), the engines the app knows and one
// to keep (§9.1), the fingerprint an engine presents over TLS and the pairing the user agreed to, its
// token crossing as text (§9.3), and the engine ports, the local engine's and those the page asks for to its other
// known engines, which the preload hands to the page as window messages (contextBridge can't carry a
// MessagePort).

/** The IPC channels between main and the preload, each named once. */
export const channels = {
  minimize: 'fabrica:window-minimize',
  toggleMaximize: 'fabrica:window-toggle-maximize',
  close: 'fabrica:window-close',
  setTheme: 'fabrica:window-set-theme',
  pickFolder: 'fabrica:pick-folder',
  version: 'fabrica:version',
  updateStatus: 'fabrica:update-status',
  updateStatusChanged: 'fabrica:update-status-changed',
  notify: 'fabrica:notify',
  notificationClicked: 'fabrica:notification-clicked',
  installLoginService: 'fabrica:install-login-service',
  checkEngine: 'fabrica:check-engine',
  installEngine: 'fabrica:install-engine',
  findWsl: 'fabrica:find-wsl',
  installUbuntu: 'fabrica:install-ubuntu',
  sshPrompt: 'fabrica:ssh-prompt',
  answerSshPrompt: 'fabrica:ssh-prompt-answer',
  knownEngines: 'fabrica:known-engines',
  keepEngine: 'fabrica:keep-engine',
  connectEngine: 'fabrica:connect-engine',
  readFingerprint: 'fabrica:read-fingerprint',
  pairEngine: 'fabrica:pair-engine',
  enginePort: 'fabrica:engine-port',
  remoteEnginePort: 'fabrica:remote-engine-port',
} as const

/** A folder the user picked, or none. */
export const FolderPick = Schema.TaggedUnion({
  Picked: { path: Schema.NonEmptyString },
  Cancelled: {},
})
export type FolderPick = typeof FolderPick.Type

/** Where the app's own update stands (spec §22.2). */
export const UpdateStatus = Schema.TaggedUnion({
  /** This build doesn't update itself: a development build, or a deb or rpm, updated by hand. */
  Unavailable: {},
  /** No check yet, or none since the last. */
  Idle: {},
  Checking: {},
  UpToDate: {},
  Downloading: {
    version: ReleaseVersion,
    percent: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  },
  /** Downloaded, installed as the app restarts. */
  Ready: { version: ReleaseVersion },
  Failed: { reason: Schema.String },
})
export type UpdateStatus = typeof UpdateStatus.Type

/** What the preload exposes to the page as `window.fabrica`. */
export interface FabricaApi {
  readonly window: {
    readonly minimize: () => void
    readonly toggleMaximize: () => void
    readonly close: () => void
    /** The theme the page shows, so main colours the native title bar and window to match. */
    readonly setTheme: (theme: Theme) => void
  }
  readonly pickFolder: () => Promise<FolderPick>
  readonly version: () => Promise<ReleaseVersion>
  readonly updateStatus: () => Promise<UpdateStatus>
  /** Calls `listener` with each new update status; the function returned stops it. */
  readonly onUpdateStatus: (
    listener: (status: UpdateStatus) => void,
  ) => () => void
  /** System notifications, and the targets of those clicked. */
  readonly notifications: NotificationsApi
  /** Installs the local engine as a login service, as the user chose (spec §7.1). */
  readonly [installLoginServiceMethod]: () => Promise<ServiceInstall>
  /** Checks a host for an engine, and what installing the app's would do (§9.2). */
  readonly [checkEngineMethod]: (host: EngineHost) => Promise<CheckAnswer>
  /** Installs or updates the engine on a host, as the user agreed. */
  readonly [installEngineMethod]: (
    host: EngineHost,
    consent: InstallConsent,
  ) => Promise<InstallAnswer>
  /** Looks for the WSL2 distribution to run the engine in (§7.6). */
  readonly [findWslMethod]: () => Promise<WslSearch>
  /** Installs Ubuntu in WSL, as the user agreed, and looks for the distribution again. */
  readonly [installUbuntuMethod]: () => Promise<UbuntuInstall>
  /** What ssh asks as the app connects, and the page's answers (spec §9.1). */
  readonly [sshPromptsMember]: SshPromptsApi
  /** The engines the app knows, from its state (§9.1). */
  readonly [knownEnginesMethod]: () => Promise<KnownEnginesAnswer>
  /** Keeps an engine among the app's known engines, or replaces the one of its name. */
  readonly [keepEngineMethod]: (engine: KnownEngine) => Promise<KeepAnswer>
  /** Asks for a port to a known engine, which comes as a window message carrying the request's number. */
  readonly [connectEngineMethod]: (request: EnginePortRequest) => void
  /** The fingerprint of the certificate the engine at an endpoint presents, at a first pairing (§9.3). */
  readonly [readFingerprintMethod]: (
    endpoint: TlsEndpoint,
  ) => Promise<FingerprintAnswer>
  /** Hands main the pairing the user agreed to, encoded: the token as text. */
  readonly [pairEngineMethod]: (
    request: typeof PairRequest.Encoded,
  ) => Promise<PairAnswer>
}

/** The part of `ipcRenderer` the API uses; a listener gets a message's value and the ports it carries. */
export interface PreloadIpc {
  readonly send: (channel: string, ...values: ReadonlyArray<unknown>) => void
  readonly invoke: (
    channel: string,
    ...values: ReadonlyArray<unknown>
  ) => Promise<unknown>
  readonly on: (
    channel: string,
    listener: (value: unknown, ports: ReadonlyArray<unknown>) => void,
  ) => () => void
}

// A value that doesn't decode throws: the page's call fails, or main's answer rejects its promise.
const decodeFolderPick = Schema.decodeUnknownSync(FolderPick)
const decodeVersion = Schema.decodeUnknownSync(ReleaseVersion)
const decodeUpdateStatus = Schema.decodeUnknownSync(UpdateStatus)
const decodeTheme = Schema.decodeUnknownSync(Theme)
const decodeUpdateStatusOption = Schema.decodeUnknownOption(UpdateStatus)
const decodeNotification = Schema.decodeUnknownSync(DesktopNotification)
const decodeTargetOption = Schema.decodeUnknownOption(NotificationTarget)
const decodeServiceInstall = Schema.decodeUnknownSync(ServiceInstall)
const decodeEngineHost = Schema.decodeUnknownSync(EngineHost)
const decodeConsent = Schema.decodeUnknownSync(InstallConsent)
const decodeCheckAnswer = Schema.decodeUnknownSync(CheckAnswer)
const decodeInstallAnswer = Schema.decodeUnknownSync(InstallAnswer)
const decodeWslSearch = Schema.decodeUnknownSync(WslSearch)
const decodeUbuntuInstall = Schema.decodeUnknownSync(UbuntuInstall)
// A prompt crosses to the page encoded (contextBridge copies plain values only), and the page decodes it.
const decodeSshEventOption = Schema.decodeUnknownOption(SshPromptEvent)
const encodeSshEvent = Schema.encodeSync(SshPromptEvent)
const decodeSshAnswer = Schema.decodeUnknownSync(SshPromptAnswer)
const encodeSshAnswer = Schema.encodeSync(SshPromptAnswer)
const decodeKnownEngines = Schema.decodeUnknownSync(KnownEnginesAnswer)
const decodeKnownEngine = Schema.decodeUnknownSync(KnownEngine)
const encodeKnownEngine = Schema.encodeSync(KnownEngine)
const decodeKeepAnswer = Schema.decodeUnknownSync(KeepAnswer)
const decodePortRequest = Schema.decodeUnknownSync(EnginePortRequest)
const encodePortRequest = Schema.encodeSync(EnginePortRequest)
const decodeEndpoint = Schema.decodeUnknownSync(TlsEndpoint)
const decodeFingerprintAnswer = Schema.decodeUnknownSync(FingerprintAnswer)
const decodePairRequest = Schema.decodeUnknownSync(PairRequest)
const encodePairRequest = Schema.encodeSync(PairRequest)
const decodePairAnswer = Schema.decodeUnknownSync(PairAnswer)
const decodePortAnswer = Schema.decodeUnknownOption(
  Schema.Struct({ request: Schema.Int }),
)

/** The API over `ipc`: what the page passes is decoded before it is sent, what main answers before the page sees it. */
export const makeApi = (ipc: PreloadIpc): FabricaApi => ({
  window: {
    minimize: () => ipc.send(channels.minimize),
    toggleMaximize: () => ipc.send(channels.toggleMaximize),
    close: () => ipc.send(channels.close),
    setTheme: theme => ipc.send(channels.setTheme, decodeTheme(theme)),
  },
  pickFolder: () => ipc.invoke(channels.pickFolder).then(decodeFolderPick),
  version: () => ipc.invoke(channels.version).then(decodeVersion),
  updateStatus: () =>
    ipc.invoke(channels.updateStatus).then(decodeUpdateStatus),
  onUpdateStatus: listener =>
    ipc.on(channels.updateStatusChanged, value => {
      Option.map(decodeUpdateStatusOption(value), listener)
    }),
  notifications: {
    notify: notification =>
      ipc.send(channels.notify, decodeNotification(notification)),
    onClick: listener =>
      ipc.on(channels.notificationClicked, value => {
        Option.map(decodeTargetOption(value), listener)
      }),
  },
  [installLoginServiceMethod]: () =>
    ipc.invoke(channels.installLoginService).then(decodeServiceInstall),
  // Decoded inside the promise, so a host or consent that doesn't decode rejects it.
  [checkEngineMethod]: host =>
    Promise.resolve()
      .then(() => ipc.invoke(channels.checkEngine, decodeEngineHost(host)))
      .then(decodeCheckAnswer),
  [installEngineMethod]: (host, consent) =>
    Promise.resolve()
      .then(() =>
        ipc.invoke(
          channels.installEngine,
          decodeEngineHost(host),
          decodeConsent(consent),
        ),
      )
      .then(decodeInstallAnswer),
  [findWslMethod]: () => ipc.invoke(channels.findWsl).then(decodeWslSearch),
  [installUbuntuMethod]: () =>
    ipc.invoke(channels.installUbuntu).then(decodeUbuntuInstall),
  [sshPromptsMember]: {
    onEvent: listener =>
      ipc.on(channels.sshPrompt, value => {
        Option.map(decodeSshEventOption(value), event =>
          listener(encodeSshEvent(event)),
        )
      }),
    answer: answer =>
      ipc.send(
        channels.answerSshPrompt,
        encodeSshAnswer(decodeSshAnswer(answer)),
      ),
  },
  [knownEnginesMethod]: () =>
    ipc.invoke(channels.knownEngines).then(decodeKnownEngines),
  [keepEngineMethod]: engine =>
    Promise.resolve()
      .then(() =>
        ipc.invoke(
          channels.keepEngine,
          encodeKnownEngine(decodeKnownEngine(engine)),
        ),
      )
      .then(decodeKeepAnswer),
  [connectEngineMethod]: request =>
    ipc.send(
      channels.connectEngine,
      encodePortRequest(decodePortRequest(request)),
    ),
  [readFingerprintMethod]: endpoint =>
    Promise.resolve()
      .then(() =>
        ipc.invoke(channels.readFingerprint, decodeEndpoint(endpoint)),
      )
      .then(decodeFingerprintAnswer),
  [pairEngineMethod]: request =>
    Promise.resolve()
      .then(() =>
        ipc.invoke(
          channels.pairEngine,
          encodePairRequest(decodePairRequest(request)),
        ),
      )
      .then(decodePairAnswer),
})

/** Hands the page each engine port main sends, as a window message of type `fabrica:engine-port`. */
export const forwardEnginePorts = (
  ipc: PreloadIpc,
  post: (message: { readonly type: string }, ports: [MessagePort]) => void,
): (() => void) =>
  ipc.on(channels.enginePort, (_value, ports) => {
    const [port] = ports
    if (ports.length === 1 && port instanceof MessagePort) {
      post({ type: enginePortMessage }, [port])
    }
  })

/**
 * Hands the page each port main sends to a known engine, as a window message of type
 * `fabrica:remote-engine-port` carrying the number of the request it answers.
 */
export const forwardRemoteEnginePorts = (
  ipc: PreloadIpc,
  post: (
    message: { readonly type: string; readonly request: number },
    ports: [MessagePort],
  ) => void,
): (() => void) =>
  ipc.on(channels.remoteEnginePort, (value, ports) => {
    const [port] = ports
    if (ports.length === 1 && port instanceof MessagePort) {
      Option.map(decodePortAnswer(value), ({ request }) =>
        post({ type: remoteEnginePortMessage, request }, [port]),
      )
    }
  })
