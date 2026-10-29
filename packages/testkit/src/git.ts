import { Effect, Option, type Scope } from 'effect'
import { mkdir, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { CommitHash } from '@fabrica/contracts'

import { runCommand } from './command'
import { CommandFailed, KitFailed } from './errors'
import { tempFolder } from './temp'
import type { Tools } from './toolbox'

// A git repository in a temp folder with a bare remote (spec §24: git-subject behaviour against real
// git in temp folders). Git runs with the toolbox's PATH, which must hold `git`, and reads no
// configuration but the repository's: not the system's, not the user's.

export interface GitRepo {
  /** The temp folder holding both repositories. */
  readonly root: string
  /** The checkout: on `main`, with one commit, tracking `origin/main`. */
  readonly work: string
  /** The bare repository the checkout's `origin` names. */
  readonly remote: string
  /** The environment git runs with. */
  readonly env: Readonly<Record<string, string>>
  /** Runs git with `args` in the checkout, or in `cwd`; what it printed, trimmed. */
  readonly git: (
    args: ReadonlyArray<string>,
    cwd?: string,
  ) => Effect.Effect<string, CommandFailed>
  /** Writes `files` (paths relative to the checkout) and commits them; the new commit. */
  readonly commit: (options: {
    readonly files: Readonly<Record<string, string>>
    readonly message: string
  }) => Effect.Effect<CommitHash, CommandFailed | KitFailed>
}

/** The identity commits are made with, and the configuration git reads none of. */
const gitVars = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fabrica Test',
  GIT_AUTHOR_EMAIL: 'test@fabrica.invalid',
  GIT_COMMITTER_NAME: 'Fabrica Test',
  GIT_COMMITTER_EMAIL: 'test@fabrica.invalid',
}

/** Makes a checkout and its bare remote in a temp folder removed as the scope closes. */
export const makeGitRepo = (
  tools: Tools,
): Effect.Effect<GitRepo, CommandFailed | KitFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* tempFolder('git')
    const work = NodePath.join(root, 'work')
    const remote = NodePath.join(root, 'remote.git')
    const env = tools.env(gitVars)
    const git = (args: ReadonlyArray<string>, cwd = work) =>
      runCommand({ command: 'git', args, cwd, env }).pipe(
        Effect.map(output => output.trim()),
      )
    const commit: GitRepo['commit'] = ({ files, message }) =>
      Effect.gen(function* () {
        yield* Effect.forEach(Object.entries(files), ([name, text]) => {
          const path = NodePath.join(work, name)
          return Effect.tryPromise({
            try: async () => {
              await mkdir(NodePath.dirname(path), { recursive: true })
              await writeFile(path, text)
            },
            catch: cause =>
              new KitFailed({ operation: 'write a file', path, cause }),
          })
        })
        yield* git(['add', '--', ...Object.keys(files)])
        yield* git(['commit', '--quiet', '--message', message])
        const head = yield* git(['rev-parse', 'HEAD'])
        return yield* Option.match(CommitHash.makeOption(head), {
          onNone: () =>
            Effect.fail(
              new CommandFailed({
                command: 'git',
                args: ['rev-parse', 'HEAD'],
                cwd: work,
                stderr: `not a commit: ${head}`,
              }),
            ),
          onSome: Effect.succeed,
        })
      })
    yield* git(
      ['init', '--quiet', '--bare', '--initial-branch=main', remote],
      root,
    )
    yield* git(['init', '--quiet', '--initial-branch=main', work], root)
    const repo: GitRepo = { root, work, remote, env, git, commit }
    yield* commit({
      files: { 'README.md': '# Test\n' },
      message: 'First commit',
    })
    yield* git(['remote', 'add', 'origin', remote])
    yield* git(['push', '--quiet', '--set-upstream', 'origin', 'main'])
    return repo
  })
