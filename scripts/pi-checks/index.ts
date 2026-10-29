// scripts/pi-checks: a development-only Pi package (spec §23), loaded by .pi/settings.json for a Pi
// agent working on Fabrica, never shipped with the app. After each write or edit, its tool_result
// handler runs the checks of ../check-write.ts on the file and adds their report to the tool's
// result, so the agent reads the problems with the result itself.
// Pi isn't a dependency of the repository yet, so the part of its extension API used here is typed
// structurally below; Pi's own ExtensionAPI and tool_result event fit it.
import { Option } from 'effect'

import {
  type Run,
  checkWritten,
  repositoryRoot,
  spawnRun,
} from '../check-write.ts'

/** The fields of Pi's tool_result event read here. */
export interface ToolResultEvent {
  readonly toolName: string
  readonly input: unknown
  readonly content: ReadonlyArray<unknown>
  readonly isError: boolean
}

/** What a tool_result handler returns: the result's content, replaced. */
export interface ToolResultPatch {
  readonly content: ReadonlyArray<unknown>
}

/** The part of Pi's ExtensionAPI used here. */
export interface PiExtensionApi {
  readonly on: (
    event: 'tool_result',
    handler: (
      event: ToolResultEvent,
      context: { readonly cwd: string },
    ) => Promise<ToolResultPatch | undefined>,
  ) => void
}

/** The file a write or edit that succeeded wrote, as its input names it; none for any other result. */
export const piWritten = (event: ToolResultEvent): Option.Option<string> => {
  if (
    event.isError ||
    (event.toolName !== 'write' && event.toolName !== 'edit')
  ) {
    return Option.none()
  }
  const { input } = event
  const path =
    typeof input === 'object' && input !== null && 'path' in input
      ? input.path
      : undefined
  return typeof path === 'string' ? Option.some(path) : Option.none()
}

/** The tool_result handler: the result with the checks' report added, or no patch where they passed. */
export const afterWrite = async (input: {
  readonly event: ToolResultEvent
  readonly cwd: string
  readonly root: string
  readonly run: Run
  readonly bin?: (tool: string) => string
}): Promise<ToolResultPatch | undefined> => {
  const { event, cwd, root, run, bin } = input
  const path = piWritten(event)
  if (Option.isNone(path)) return undefined
  const found = await checkWritten({
    root,
    cwd,
    paths: [path.value],
    run,
    ...(bin === undefined ? {} : { bin }),
  })
  return Option.match(found, {
    onNone: () => undefined,
    onSome: text => ({
      content: [...event.content, { type: 'text', text }],
    }),
  })
}

export default (pi: PiExtensionApi): void => {
  const root = repositoryRoot()
  const run = spawnRun(root, process.env)
  pi.on('tool_result', (event, context) =>
    afterWrite({ event, cwd: context.cwd, root, run }),
  )
}
