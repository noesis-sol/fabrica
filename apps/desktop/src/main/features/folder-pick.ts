import type { OpenDialogOptions } from 'electron'

import { FolderPick, channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'

// A folder picked in the system's dialog, as the page asks for one: over the app's window where it is
// open.

/** What main does to pick a folder. */
export interface FolderPickActions {
  readonly pickFolder: () => Promise<FolderPick>
}

/** Registers the folder pick's channel on `ipc`, answered by `actions`. */
export const folderPickChannels = (
  ipc: IpcRegistrar,
  actions: FolderPickActions,
): void => ipc.onInvoke(channels.pickFolder, actions.pickFolder)

/** Registers the folder pick on `ipc`, in Electron's dialog. */
export const registerFolderPick = (
  ipc: IpcRegistrar,
  { dialog, appWindow }: MainContext,
): void =>
  folderPickChannels(ipc, {
    pickFolder: async () => {
      const options: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
      }
      const window = appWindow.current()
      const { canceled, filePaths } =
        window === undefined
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options)
      const [path] = filePaths
      return canceled || path === undefined || path === ''
        ? FolderPick.cases.Cancelled.make({})
        : FolderPick.cases.Picked.make({ path })
    },
  })
