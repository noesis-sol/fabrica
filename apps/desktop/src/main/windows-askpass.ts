import * as NodePath from 'node:path'

// Where the Windows app's `SSH_ASKPASS` helper lies (spec §9.1): built into `stage/askpass` as the app is
// packed (build/askpass.ts), and copied from there into the `askpass` folder of its resources
// (electron-builder.yml). This module is loaded by that build's hook too, so it imports only Node's own.

/** The helper's file. */
export const windowsAskpassProgram = 'fabrica-askpass.exe'

/** The helper in the packaged app with `resources`. */
export const windowsAskpass = (resources: string): string =>
  NodePath.join(resources, 'askpass', windowsAskpassProgram)
