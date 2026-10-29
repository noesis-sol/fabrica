import { Option } from 'effect'

import {
  ControlSocketVariable,
  ControlTokenVariable,
  ProjectTrustedVariable,
} from '@fabrica/contracts'

// What the extension reads from its agent's environment, which the engine sets at spawn (spec §12.1,
// §12.2, §20.2): the control socket's path and token, whether the user trusts the project, and Pi's
// configuration folder. Read once, where the extension loads, and passed on.

/** Pi's variable naming its configuration folder, where the engine writes `models.json` (§12.9). */
export const PiConfigFolderVariable = 'PI_CODING_AGENT_DIR'

export interface ExtensionEnvironment {
  /** The control socket's path and the session's token, when the engine gave both. */
  readonly control: Option.Option<{
    readonly socket: string
    readonly token: string
  }>
  /** Whether the user trusts the project, so Pi may load its own settings and packages. */
  readonly projectTrusted: boolean
  /** The agent's own Pi configuration folder. */
  readonly configFolder: Option.Option<string>
}

const given = (value: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(value), text => text.length > 0)

/** The extension's facts, from an environment's variables. */
export const readEnvironment = (
  variables: Readonly<Record<string, string | undefined>>,
): ExtensionEnvironment => ({
  control: Option.zipWith(
    given(variables[ControlSocketVariable]),
    given(variables[ControlTokenVariable]),
    (socket, token) => ({ socket, token }),
  ),
  projectTrusted: variables[ProjectTrustedVariable] === '1',
  configFolder: given(variables[PiConfigFolderVariable]),
})
