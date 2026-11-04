import { Data, Option, Schema } from 'effect'

import {
  AgentRole,
  AgentRoleVariable,
  AnswerToolGiven,
  AnswerToolVariable,
  ControlAddressVariable,
  ControlSocketVariable,
  ControlTokenVariable,
  OrganFilesRootVariable,
  Permissions,
  PermissionsVariable,
  ProjectTrustedVariable,
  TalkToolsGiven,
  TalkToolsVariable,
} from '@fabrica/contracts'

// What the extension reads from its agent's environment, which the engine sets at spawn (spec §12.1,
// §12.2, §12.6, §13.6, §15.4, §16, §20.2): the control socket's path and token, the agent's role, an organ's answer tool, a talk's tools, whether the user
// trusts the project, the level the gate enforces, Pi's configuration folder, the home folder and how
// the agent's shell searches for a `cd` target; and the worktree, the folder Pi runs in. Read once, where the extension loads, and passed on.

/** Pi's variable naming its configuration folder, where the engine writes `models.json` (§12.9). */
export const PiConfigFolderVariable = 'PI_CODING_AGENT_DIR'

/** Where the engine's control channel is: a mounted socket, or a TCP address where one can't be connected (§12.7). */
export type ControlEndpoint = Data.TaggedEnum<{
  Unix: { readonly socket: string }
  Tcp: { readonly host: string; readonly port: number }
}>
export const ControlEndpoint = Data.taggedEnum<ControlEndpoint>()

export interface ExtensionEnvironment {
  /** The control channel and the session's token, when the engine gave both. */
  readonly control: Option.Option<{
    readonly endpoint: ControlEndpoint
    readonly token: string
  }>
  /**
   * The ticket's worker, its verifier, whose one tool is `verdict`, an organ's session, whose one
   * tool is `answer`, or a talk, whose tools are its mode's; a worker where the engine gave none it reads.
   */
  readonly role: AgentRole
  /** An organ session's `answer` tool, when the engine gave one it reads. */
  readonly answerTool: Option.Option<AnswerToolGiven>
  /** A talk's tools, none where the engine gave none it reads. */
  readonly talkTools: TalkToolsGiven
  /** Whether an organ's session has `file_root` beside its `answer`: the spec breakdown's (§15.5). */
  readonly organFilesRoot?: boolean
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
  /** `CDPATH` is set, so the agent's shell searches its folders for a relative `cd` target. */
  readonly cdPath: boolean
  /** `BASHOPTS` turns `cdable_vars` on, so the agent's shell may take a `cd` target as a variable's name. */
  readonly cdableVariables: boolean
}

const given = (value: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(value), text => text.length > 0)

/** The endpoint of an address, `<host>:<port>`; none where it isn't one. */
const tcpEndpoint = (address: string): Option.Option<ControlEndpoint> => {
  const colon = address.lastIndexOf(':')
  const port = Number(address.slice(colon + 1))
  return colon > 0 && Number.isInteger(port) && port > 0
    ? Option.some(ControlEndpoint.Tcp({ host: address.slice(0, colon), port }))
    : Option.none()
}

/** The extension's facts, from an environment's variables and the folder Pi runs in. */
export const readEnvironment = (
  variables: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ExtensionEnvironment => ({
  control: Option.zipWith(
    Option.orElse(
      Option.flatMap(given(variables[ControlAddressVariable]), tcpEndpoint),
      () =>
        Option.map(given(variables[ControlSocketVariable]), socket =>
          ControlEndpoint.Unix({ socket }),
        ),
    ),
    given(variables[ControlTokenVariable]),
    (endpoint, token) => ({ endpoint, token }),
  ),
  role: Option.getOrElse(
    Schema.decodeUnknownOption(AgentRole)(variables[AgentRoleVariable]),
    () => 'worker' as const,
  ),
  answerTool: Schema.decodeUnknownOption(AnswerToolGiven)(
    variables[AnswerToolVariable],
  ),
  talkTools: Option.getOrElse(
    Schema.decodeUnknownOption(TalkToolsGiven)(variables[TalkToolsVariable]),
    () => [],
  ),
  organFilesRoot: variables[OrganFilesRootVariable] === '1',
  projectTrusted: variables[ProjectTrustedVariable] === '1',
  configFolder: given(variables[PiConfigFolderVariable]),
  permissions: Option.getOrElse(
    Schema.decodeUnknownOption(Permissions)(variables[PermissionsVariable]),
    () => 'workspace' as const,
  ),
  worktree: cwd,
  home: given(variables['HOME']),
  cdPath: Option.isSome(given(variables['CDPATH'])),
  cdableVariables: (variables['BASHOPTS'] ?? '')
    .split(':')
    .includes('cdable_vars'),
})
