import { Option } from 'effect'
import * as NodePath from 'node:path'

// The app's own data folder (spec §7.2), Electron's userData: Chromium's storage, with the page's, and the
// theme the window opens in. Electron names it after package.json's name, @fabrica/desktop; a packaged app
// names it after the product, in the platform's folder for applications' data. Not `Fabrica` on macOS: the
// engine's data folder there is ~/Library/Application Support/fabrica, the same folder on a
// case-insensitive disk, so the app's is named after its ID. A development build keeps Electron's, so it
// shares neither the installed app's storage nor its single-instance lock.

/** The app's ID, as electron-builder.yml gives it to the packages. */
export const appId = 'solutions.noesis.fabrica'

/** The app's name, as electron-builder.yml gives it to the packages. */
export const productName = 'Fabrica'

/** The data folder of the app on `platform`, under `appData` (Electron's): none for a development build. */
export const appDataFolder = ({
  platform,
  packaged,
  appData,
}: {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly appData: string
}): Option.Option<string> =>
  packaged
    ? Option.some(
        (platform === 'win32' ? NodePath.win32 : NodePath.posix).join(
          appData,
          platform === 'darwin' ? appId : productName,
        ),
      )
    : Option.none()
