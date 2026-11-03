import { Data, Effect, Option, Schema } from 'effect'

import { type Requirement, Requires } from '@fabrica/contracts'

import { Git } from '../git'
import { projectSettingsPath, settingsFileMaxBytes } from '../settings'
import { isJsonObject, parseJson, valueAt } from '../settings/values'

// The requires list as Base has it (spec §17). The engine runs only the commands of Base's list, as they
// are there, so it reads them from the commit, never from a checkout's file: an entry a branch adds or
// changes isn't on Base until it merges, and is the worker's to run, through the gate (§12.6).

/** What a commit's settings file gives for the requires list. */
export type RequirementsList = Data.TaggedEnum<{
  /** Its list; empty where the commit has no settings file, or the file no `requires`. */
  Listed: { readonly list: ReadonlyArray<Requirement> }
  Unreadable: { readonly reason: string }
}>
export const RequirementsList = Data.taggedEnum<RequirementsList>()

const decodeRequires = Schema.decodeUnknownEffect(Requires)

/** The list in the text of a settings file. */
const listIn = (text: string) =>
  Option.match(
    text.length > settingsFileMaxBytes ? Option.none() : parseJson(text),
    {
      onNone: () =>
        Effect.succeed(
          RequirementsList.Unreadable({
            reason: `${projectSettingsPath} isn't JSON of at most ${settingsFileMaxBytes} bytes`,
          }),
        ),
      onSome: document =>
        isJsonObject(document)
          ? decodeRequires(
              Option.getOrElse(valueAt(document, ['requires']), () => []),
            ).pipe(
              Effect.map(list => RequirementsList.Listed({ list })),
              Effect.catch(error =>
                Effect.succeed(
                  RequirementsList.Unreadable({
                    reason: `requires in ${projectSettingsPath}: ${error.message}`,
                  }),
                ),
              ),
            )
          : Effect.succeed(
              RequirementsList.Unreadable({
                reason: `${projectSettingsPath} isn't a JSON object`,
              }),
            ),
    },
  )

/** The requires list committed at `revision` of the repository at `repo`. */
export const requirementsAt = Effect.fn('Requirements.at')(function* ({
  repo,
  revision,
}: {
  readonly repo: string
  readonly revision: string
}) {
  const git = yield* Git
  return yield* git.fileAt({ repo, revision, path: projectSettingsPath }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(RequirementsList.Listed({ list: [] })),
        onSome: listIn,
      }),
    ),
    Effect.catchTag('CantTell', ({ reason }) =>
      Effect.succeed(RequirementsList.Unreadable({ reason })),
    ),
  )
})

/** An entry in words: its check, what meets it and its platforms, so a change to any of them shows. */
export const requirementWords = (requirement: Requirement): string =>
  [
    requirement.check,
    requirement.meets._tag === 'Install'
      ? `install: ${requirement.meets.command}`
      : `manual: ${requirement.meets.instruction}`,
    ...Option.match(requirement.platforms, {
      onNone: () => [],
      onSome: platforms => [`on ${platforms.join(', ')}`],
    }),
  ].join('; ')

/** Whether two lists have the same entries, whatever their order. */
export const sameRequirements = (
  one: ReadonlyArray<Requirement>,
  other: ReadonlyArray<Requirement>,
): boolean => {
  const words = new Map(
    one.map(requirement => [requirement.name, requirementWords(requirement)]),
  )
  return (
    one.length === other.length &&
    other.every(
      requirement =>
        words.get(requirement.name) === requirementWords(requirement),
    )
  )
}
