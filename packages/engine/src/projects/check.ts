import { Array, Data, Effect, Option } from 'effect'
import { stat } from 'node:fs/promises'

import { type CheckoutPlace, Git, GitVersion, isLinkedWorktree } from '../git'
import { describeProblem } from '../settings'
import { readSettings } from './settings'

// The check a project is given as it is added (spec §10.1, §13.1): what a run's start checks of it
// that doesn't change from run to run. Git must be 2.38 or later; the folder a checkout's, its
// repository's main checkout (a linked worktree's tickets would get worktrees of a worktree), on a
// branch, which is Base; its settings, where it has them, valid. Every problem is listed together. A
// run's start checks the rest again as it starts: the checkout clean, the settings, the requirements.

/** What the check found. */
export type ProjectCheck = Data.TaggedEnum<{
  /** The checkout at `place`, on `base`. */
  Usable: { readonly place: CheckoutPlace; readonly base: string }
  Unusable: { readonly problems: Array.NonEmptyReadonlyArray<string> }
}>
export const ProjectCheck = Data.taggedEnum<ProjectCheck>()

const unusable = (problem: string, ...more: ReadonlyArray<string>) =>
  ProjectCheck.Unusable({ problems: [problem, ...more] })

/** What is wrong with the git commands run with; none where it is one the engine can use. */
const gitProblem = GitVersion.$match({
  Supported: () => Option.none<string>(),
  TooOld: ({ version, minimum }) =>
    Option.some(`${version} is older than git ${minimum}, which Fabrica needs`),
  Missing: ({ path }) => Option.some(`git is not on the PATH (${path})`),
  Unreadable: ({ reason }) => Option.some(reason),
})

/** Checks the project whose checkout is at, or holds, `folder`. */
export const checkProject = Effect.fn('Projects.check')(
  function* (folder: string) {
    const git = yield* Git
    const isFolder = yield* Effect.tryPromise(() => stat(folder)).pipe(
      Effect.map(found => found.isDirectory()),
      Effect.orElseSucceed(() => false),
    )
    if (!isFolder) return unusable(`there is no folder at ${folder}`)
    const tooOld = gitProblem(yield* git.version)
    if (Option.isSome(tooOld)) return unusable(tooOld.value)

    const place = yield* git.checkoutOf({ folder })
    if (Option.isNone(place))
      return unusable(`${folder} is not in a git checkout`)
    const { top, commonDir } = place.value
    if (isLinkedWorktree(place.value))
      return unusable(
        `${top} is a worktree of the checkout whose git folder is ${commonDir}: add that checkout`,
      )

    const [branch, settings] = yield* Effect.all(
      [
        git.currentBranch({ repo: top }),
        readSettings(top).pipe(
          Effect.as<ReadonlyArray<string>>([]),
          Effect.catchTag('SettingsProblems', ({ problems }) =>
            Effect.succeed(problems.map(describeProblem)),
          ),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    return Option.match(branch, {
      onNone: () =>
        unusable(
          `${top} is on no branch (a detached HEAD): check out the branch tickets are to land on`,
          ...settings,
        ),
      onSome: base =>
        Array.isReadonlyArrayNonEmpty(settings)
          ? ProjectCheck.Unusable({ problems: settings })
          : ProjectCheck.Usable({ place: place.value, base }),
    })
  },
  Effect.catchTag('CantTell', ({ read, reason }) =>
    Effect.succeed(unusable(`git couldn't tell (${read}): ${reason}`)),
  ),
)
