import type { ReleaseVersion } from '@fabrica/contracts'

import { type UpdateStatus, channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'

// The app's version and where its own update stands (spec §22.2), as the page asks for them; the
// window pushes each change of the status itself.

/** What main tells the page of the app's release. */
export interface AppVersionActions {
  readonly version: ReleaseVersion
  readonly updateStatus: () => UpdateStatus
}

/** Registers the version's and the update status's channels on `ipc`, answered by `actions`. */
export const appVersionChannels = (
  ipc: IpcRegistrar,
  actions: AppVersionActions,
): void => {
  ipc.onInvoke(channels.version, () => Promise.resolve(actions.version))
  ipc.onInvoke(channels.updateStatus, () =>
    Promise.resolve(actions.updateStatus()),
  )
}

/** Registers the app's version and update status on `ipc`. */
export const registerAppVersion = (
  ipc: IpcRegistrar,
  { version, updateStatus }: MainContext,
): void => appVersionChannels(ipc, { version, updateStatus: updateStatus.get })
