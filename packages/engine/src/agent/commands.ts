import { Data, Match } from 'effect'

// The commands the engine sends Pi in RPC mode (spec §12.1), each one JSON line on Pi's stdin.

/** A provider and model, as Pi names them (`anthropic`, `claude-…`). */
export interface ModelChoice {
  readonly provider: string
  readonly modelId: string
}

/** A command the engine sends an agent; Pi answers each with a response carrying its `id`. */
export type PiCommand = Data.TaggedEnum<{
  /** The handshake: the session Pi opened. */
  GetState: {}
  /** The first prompt, or a hand-back. */
  Prompt: { readonly message: string }
  /** A maintainer's message, delivered into the running turn. */
  Steer: { readonly message: string }
  Abort: {}
  SetModel: { readonly model: ModelChoice }
  /** A resume: the session file to carry on from. */
  SwitchSession: { readonly sessionPath: string }
  Fork: { readonly entryId: string }
  GetSessionStats: {}
}>
export const PiCommand = Data.taggedEnum<PiCommand>()

/** The command's name, as Pi's `type` and its response's `command` give it. */
export const commandName: (command: PiCommand) => string =
  Match.type<PiCommand>().pipe(
    Match.tagsExhaustive({
      GetState: () => 'get_state',
      Prompt: () => 'prompt',
      Steer: () => 'steer',
      Abort: () => 'abort',
      SetModel: () => 'set_model',
      SwitchSession: () => 'switch_session',
      Fork: () => 'fork',
      GetSessionStats: () => 'get_session_stats',
    }),
  )

/** The command's fields beyond its `id` and `type`. */
const body: (command: PiCommand) => Readonly<Record<string, string>> =
  Match.type<PiCommand>().pipe(
    Match.tagsExhaustive({
      GetState: () => ({}),
      Prompt: ({ message }) => ({ message }),
      Steer: ({ message }) => ({ message }),
      Abort: () => ({}),
      SetModel: ({ model }) => ({
        provider: model.provider,
        modelId: model.modelId,
      }),
      SwitchSession: ({ sessionPath }) => ({ sessionPath }),
      Fork: ({ entryId }) => ({ entryId }),
      GetSessionStats: () => ({}),
    }),
  )

/** The command as the JSON line Pi reads, LF-terminated. */
export const commandLine = ({
  id,
  command,
}: {
  readonly id: string
  readonly command: PiCommand
}): string =>
  `${JSON.stringify({ id, type: commandName(command), ...body(command) })}\n`

/** The answer to an extension's dialog: cancelled, since an agent has no one to ask. */
export const cancelDialogLine = (id: string): string =>
  `${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`
