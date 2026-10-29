import { Data, Option } from 'effect'
import { fileURLToPath } from 'node:url'

import type { Permissions } from '@fabrica/contracts'

import { type CommandContext, Finding, commandFindings } from './commands'
import { Confinement, confine } from './paths'

// The permission policy (spec §12.6): a tool call read for what it does (a read, a write, a command,
// another tool) and its findings, and the project's level applied to them. `workspace` reads
// anywhere, writes and runs commands inside the worktree, and asks about the rest; `ask` asks about
// every write and command; `full` allows everything but `git push`. Every level refuses `git push`,
// and holds writes to the branch while the ticket merges, which `decide` reads from the engine.

/** Pi's built-in tools that only read. */
const readers = new Set(['read', 'grep', 'find', 'ls'])

/** What a call is. */
type Kind = 'read' | 'write' | 'command' | 'other'

/** A call, read: what it is and what it does that the levels weigh. */
export interface Analysis {
  readonly kind: Kind
  readonly findings: ReadonlyArray<Finding>
}

/** What the level makes of a call, before the merge queue is read. */
export type Ruling = Data.TaggedEnum<{
  Refuse: { readonly reason: string }
  /** Allowed, or asked about where `asks` has reasons, once the branch is free where it writes the branch. */
  Weigh: {
    readonly branchWrite: Option.Option<string>
    readonly asks: ReadonlyArray<string>
  }
}>
export const Ruling = Data.taggedEnum<Ruling>()

/** The path a Pi file tool takes, as Pi reads it: a leading `@` dropped, a `file://` URL as its path. */
const toolPath = (path: string): string => {
  const bare = path.startsWith('@') ? path.slice(1) : path
  return bare.startsWith('file://') ? fileURLToPath(bare) : bare
}

const written = (
  input: Readonly<Record<string, unknown>>,
  context: CommandContext,
): ReadonlyArray<Finding> => {
  const path = input['path']
  if (typeof path !== 'string')
    return [Finding.Ask({ reason: 'the call names no path the gate can read' })]
  return Confinement.$match(
    confine(toolPath(path), { ...context, cwd: Option.some(context.worktree) }),
    {
      Inside: () => [],
      Outside: ({ path: outside }) => [
        Finding.Ask({ reason: `writes outside the worktree: ${outside}` }),
      ],
      Unknown: ({ reason }) => [Finding.Ask({ reason })],
      Refused: ({ reason }) => [Finding.Refused({ reason })],
    },
  )
}

const powerShellPush = /\bgit\b[^\n;|&]*\bpush\b/iu

/** What the call to `tool` with `input` is and does. */
export const analyze = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  context: CommandContext,
): Analysis => {
  if (readers.has(tool)) return { kind: 'read', findings: [] }
  if (tool === 'write' || tool === 'edit')
    return { kind: 'write', findings: written(input, context) }
  const command = input['command']
  if (tool === 'bash')
    return {
      kind: 'command',
      findings:
        typeof command === 'string'
          ? commandFindings(command, context)
          : [
              Finding.Ask({
                reason: 'the call has no command the gate can read',
              }),
            ],
    }
  if (tool === 'powershell')
    return {
      kind: 'command',
      findings: [
        ...(typeof command === 'string' && powerShellPush.test(command)
          ? [Finding.Push({ command: 'git push' })]
          : []),
        Finding.Ask({ reason: 'the gate doesn’t read PowerShell commands' }),
      ],
    }
  return {
    kind: 'other',
    findings: [
      Finding.Ask({ reason: `the gate doesn’t know the tool ${tool}` }),
    ],
  }
}

/** The project's level applied to a call's analysis. */
export const rule = (permissions: Permissions, analysis: Analysis): Ruling => {
  const refusals: Array<string> = []
  const asks: Array<string> = []
  let branchWrite = Option.none<string>()
  for (const finding of analysis.findings)
    Finding.$match(finding, {
      Push: ({ command }) =>
        refusals.push(
          `${command}: workers never push; the engine pushes after merging`,
        ),
      Refused: ({ reason }) => {
        if (permissions !== 'full') refusals.push(reason)
      },
      Ask: ({ reason }) => {
        if (permissions !== 'full') asks.push(reason)
      },
      BranchWrite: ({ command }) => {
        if (Option.isNone(branchWrite)) branchWrite = Option.some(command)
      },
    })
  const [refusal] = refusals
  if (refusal !== undefined) return Ruling.Refuse({ reason: refusal })
  return Ruling.Weigh({
    branchWrite,
    asks:
      permissions === 'ask' && analysis.kind !== 'read'
        ? [
            'the project’s permissions are `ask`: every write and command is asked',
            ...asks,
          ]
        : asks,
  })
}
