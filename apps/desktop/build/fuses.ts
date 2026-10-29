import * as NodePath from 'node:path'

import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import type { FuseV1Config } from '@electron/fuses'

// The Electron fuses the packaged app is built with (spec §20.1), flipped in the Electron binary after
// it is packed and before it is signed, since flipping changes the binary. Every fuse is set, so an
// Electron upgrade that adds one fails the build until it is decided here.
//
// - RunAsNode off: agents run on the engine's own Node, never through Electron.
// - Cookie encryption on; on Linux it needs a keyring, as safeStorage does.
// - The app loads only from its app.asar, and on macOS and Windows checks the archive against the
//   hash signed into the app (fab-a39: Electron has no asar integrity check on Linux, which relies on
//   only-load-app-from-asar).
// - The Node inspector's command-line flags stay on: Playwright's Electron support starts the
//   packaged app with --inspect=0 to drive it, and the smoke tests must test the shipped artifact
//   (spike fab-mgi.2.6). The rest keep Electron's defaults.

/** The fuses of the app built for `platform`. */
export const appFuses = (platform: NodeJS.Platform): FuseV1Config => ({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  // A fused arm64 binary's ad-hoc signature no longer matches; it is redone, then replaced by the
  // Developer ID signature where the build has one.
  resetAdHocDarwinSignature: platform === 'darwin',
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
    platform === 'darwin' || platform === 'win32',
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  [FuseV1Options.WasmTrapHandlers]: true,
})

/** What electron-builder tells an afterPack hook, of what this one reads. */
export interface PackedApp {
  readonly appOutDir: string
  readonly electronPlatformName: string
  readonly packager: {
    readonly appInfo: { readonly productFilename: string }
    readonly executableName?: string
  }
}

type FusedPlatform = 'darwin' | 'win32' | 'linux'

const fusedPlatform = (name: string): FusedPlatform => {
  if (name === 'darwin' || name === 'win32' || name === 'linux') {
    return name
  }
  throw new Error(`no fuses for the platform ${name}`)
}

/** The packed app's Electron binary, the one whose fuses are flipped. */
export const packedElectron = ({
  appOutDir,
  electronPlatformName,
  packager,
}: PackedApp): string => {
  const product = packager.appInfo.productFilename
  switch (fusedPlatform(electronPlatformName)) {
    case 'darwin':
      return NodePath.join(appOutDir, `${product}.app`)
    case 'win32':
      return NodePath.join(appOutDir, `${product}.exe`)
    case 'linux':
      return NodePath.join(appOutDir, packager.executableName ?? product)
  }
}

/** electron-builder's afterPack hook: flips the packed app's fuses before it is signed. */
export default async function flipAppFuses(packed: PackedApp): Promise<void> {
  await flipFuses(
    packedElectron(packed),
    appFuses(fusedPlatform(packed.electronPlatformName)),
  )
}
