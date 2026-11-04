import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { windowsAskpassProgram } from '../src/main/windows-askpass.ts'

// The Windows app's `SSH_ASKPASS` helper (spec §9.1, askpass.c), built as the app is packed (engine.ts's
// beforePack hook) with the packaging machine's clang into `stage/askpass`, which electron-builder.yml's
// win.extraResources copy into the app's resources, signing it where the build signs (§20.5). The C runtime
// is linked in: the helper needs nothing installed, and the app ships no Visual C++ runtime for it.

const run = promisify(execFile)

/** Builds `source` into `stage`, emptied first; a machine without clang fails, saying so. */
export const stageAskpass = async (options: {
  readonly source: string
  readonly stage: string
  /** The environment `clang` runs with, which finds it on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>
}): Promise<void> => {
  await rm(options.stage, { recursive: true, force: true })
  await mkdir(options.stage, { recursive: true })
  await run(
    'clang',
    [
      '-O2',
      '-Wall',
      '-Wextra',
      '-fms-runtime-lib=static',
      options.source,
      '-o',
      NodePath.join(options.stage, windowsAskpassProgram),
    ],
    { env: options.env },
  ).catch((cause: unknown) => {
    throw new Error(
      `could not build ${options.source}: packaging the Windows app takes clang on the PATH, with the Windows SDK and MSVC's libraries`,
      { cause },
    )
  })
}
