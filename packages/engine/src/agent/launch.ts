import { Effect, Option } from 'effect'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type ProjectId,
  ProjectTrustedVariable,
  type TicketId,
} from '@fabrica/contracts'

import { writeFileWhole } from '../files'
import type { ModelChoice } from './commands'

// How an agent's Pi is launched (spec §12.1, §12.9): its session folder, its configuration folder of
// its own, its arguments and its environment. The one place each of them is decided.

/** A provider the agent's Pi reaches through the model proxy: its Pi name and the proxy's base URL for it. */
export interface ProviderEntry {
  readonly provider: string
  readonly baseUrl: string
}

/** A ticket's session folder, where Pi keeps its sessions: `<data>/projects/<id>/sessions/<ticket>/`. */
export const sessionFolder = ({
  data,
  project,
  ticket,
}: {
  readonly data: string
  readonly project: ProjectId
  readonly ticket: TicketId
}): string => join(data, 'projects', project, 'sessions', ticket)

/** The session folder, made where it is missing. */
export const makeSessionFolder = Effect.fn('PiAgent.makeSessionFolder')(
  function* (folder: string) {
    yield* Effect.tryPromise({
      try: () => mkdir(folder, { recursive: true, mode: 0o700 }),
      catch: error => String(error),
    })
  },
)

/** Pi's `models.json`: every provider pointed at the model proxy, with the agent's token for its key. */
export const modelsJson = ({
  providers,
  token,
}: {
  readonly providers: ReadonlyArray<ProviderEntry>
  readonly token: string
}): string =>
  `${JSON.stringify(
    {
      providers: Object.fromEntries(
        providers.map(({ provider, baseUrl }) => [
          provider,
          { baseUrl, apiKey: token },
        ]),
      ),
    },
    null,
    2,
  )}\n`

/**
 * An agent's configuration folder, made under `root` and holding only the model proxy's provider
 * entries, removed with the scope. Pi reads it through `PI_CODING_AGENT_DIR`, so the user's own Pi
 * configuration and credentials are never read (spike fab-mgi.2.1).
 */
export const configFolder = Effect.fn('PiAgent.configFolder')(function* ({
  root,
  providers,
  token,
}: {
  readonly root: string
  readonly providers: ReadonlyArray<ProviderEntry>
  readonly token: string
}) {
  const folder = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(root, { recursive: true, mode: 0o700 })
        return mkdtemp(join(root, 'agent-'))
      },
      catch: error => String(error),
    }),
    made =>
      Effect.promise(() => rm(made, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  )
  yield* writeFileWhole(
    { root: folder, path: 'models.json' },
    modelsJson({ providers, token }),
    { mode: 0o600 },
  ).pipe(Effect.mapError(error => error.message))
  return folder
})

/** Pi's arguments: RPC mode, the first-party extension, the ticket's session folder. */
export const piArguments = ({
  cli,
  extension,
  sessions,
  model,
}: {
  readonly cli: string
  readonly extension: string
  readonly sessions: string
  readonly model: Option.Option<ModelChoice>
}): ReadonlyArray<string> => [
  cli,
  '--mode',
  'rpc',
  '--extension',
  extension,
  '--session-dir',
  sessions,
  // The user's skills under ~/.agents are their own configuration, which an agent never reads.
  '--no-skills',
  ...Option.match(model, {
    onNone: () => [],
    onSome: ({ provider, modelId }) => [
      '--provider',
      provider,
      '--model',
      modelId,
    ],
  }),
]

/**
 * The variables Pi gets beyond the allowlisted ones (spec §20.2): its configuration folder, and no
 * network of its own (find and grep would fetch fd and rg, a version check, telemetry); `extra`, the
 * caller's (the control socket's path and token), over them; and `FABRICA_PROJECT_TRUSTED=1` only
 * where the user trusts the project (§12.1), whatever `extra` holds. Provider keys are never
 * allowlisted, so none reaches Pi.
 */
export const piEnvironment = ({
  config,
  projectTrusted,
  extra,
}: {
  readonly config: string
  readonly projectTrusted: boolean
  readonly extra: Readonly<Record<string, string>>
}): Readonly<Record<string, string>> => ({
  PI_CODING_AGENT_DIR: config,
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  ...Object.fromEntries(
    Object.entries(extra).filter(([name]) => name !== ProjectTrustedVariable),
  ),
  ...(projectTrusted ? { [ProjectTrustedVariable]: '1' } : {}),
})
