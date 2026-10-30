import { Option, Schema } from 'effect'

import {
  AgentRole,
  AgentRoleVariable,
  ControlSocketVariable,
  ControlTokenVariable,
  Permissions,
  PermissionsVariable,
  ProjectTrustedVariable,
} from '@fabrica/contracts'

// What the extension reads from its agent's environment, which the engine sets at spawn (spec §12.1,
// §12.2, §12.6, §13.6, §20.2): the control socket's path and token, the agent's role, whether the user
// trusts the project, the level the gate enforces, Pi's configuration folder and the home folder; and
// the worktree, the folder Pi runs in. Read once, where the extension loads, and passed on.

/** Pi's variable naming its configuration folder, where the engine writes `models.json` (§12.9). */
export const PiConfigFolderVariable = 'PI_CODING_AGENT_DIR'

export interface ExtensionEnvironment {
  /** The control socket's path and the session's token, when the engine gave both. */
  readonly control: Option.Option<{
    readonly socket: string
    readonly token: string
  }>
  /** The ticket's worker, or its verifier, whose one tool is `verdict`; a worker where the engine gave none it reads. */
  readonly role: AgentRole
  /** Whether the user trusts the project, so Pi may load its own settings and packages. */
  readonly projectTrusted: boolean
  /** The agent's own Pi configuration folder. */
  readonly configFolder: Option.Option<string>
  /** The project's `permissions`; `workspace`, the default, where the engine gave none it reads. */
  readonly permissions: Permissions
  /** The ticket's worktree, where Pi runs. */
  readonly worktree: string
  /** The home folder, for paths under `~`. */
  readonly home: Option.Option<string>
}

const given = (value: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(value), text => text.length > 0)

/** The extension's facts, from an environment's variables and the folder Pi runs in. */
export const readEnvironment = (
  variables: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ExtensionEnvironment => ({
  control: Option.zipWith(
    given(variables[ControlSocketVariable]),
    given(variables[ControlTokenVariable]),
    (socket, token) => ({ socket, token }),
  ),
  role: Option.getOrElse(
    Schema.decodeUnknownOption(AgentRole)(variables[AgentRoleVariable]),
    () => 'worker' as const,
  ),
  projectTrusted: variables[ProjectTrustedVariable] === '1',
  configFolder: given(variables[PiConfigFolderVariable]),
  permissions: Option.getOrElse(
    Schema.decodeUnknownOption(Permissions)(variables[PermissionsVariable]),
    () => 'workspace' as const,
  ),
  worktree: cwd,
  home: given(variables['HOME']),
})
