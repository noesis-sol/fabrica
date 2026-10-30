import { Console, Data, Effect, Option, Ref, Schema, Stream } from 'effect'
import { Command } from 'effect/cli'

import type { EngineClientShape } from '@fabrica/client'
import {
  type ExitCode,
  type ProjectId,
  type RunEvent,
  RunEventFromJson,
  type RunId,
} from '@fabrica/contracts'

import { Json } from './flags'
import { sanitiseLine } from './sanitise'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica follow` (spec §19, §13.12): the run's events as plain lines, orchestra's plain mode: each
// record's line as the run's log says it, with its time of day, until the run ends. Records the log
// has no line for (the start, phases, checks, turns, the end) print nothing; with `--json`, each
// record is one line of JSON, all of them. `fabrica run --wait` follows its run the same way.

const encodeRecord = Schema.encodeSync(RunEventFromJson)

/** The line a record prints as, where the log has one for it: `14:03:27 <text>`. */
const lineOf = (event: RunEvent): Option.Option<string> =>
  'text' in event && event.text !== undefined
    ? Option.some(`${event.time.slice(11, 19)} ${event.text}`)
    : Option.none()

/** Prints a record: its JSON with `--json`, else its line where it has one. */
const printRecord = (json: boolean) => (event: RunEvent) =>
  json
    ? Console.log(encodeRecord(event))
    : Option.match(lineOf(event), {
        onNone: () => Effect.void,
        onSome: line => Console.log(line),
      })

/** The run's events stream ended: the exit code its `end` record gave, where it was written. */
export type Followed = Data.TaggedEnum<{
  Ended: { readonly code: ExitCode }
  /** The stream ended with no `end` record: it was lost (a full disk, §13.12). */
  Unended: {}
  /** No run is going in the project. */
  NoRun: {}
}>
export const Followed = Data.taggedEnum<Followed>()

/** Prints the run's records as they come, until it ends: the run `run` names, or the one going. */
export const followRun = (options: {
  readonly client: EngineClientShape
  readonly project: ProjectId
  readonly run: Option.Option<RunId>
  /** `--json`, read before the command reaches its engine. */
  readonly json: boolean
}) =>
  Effect.gen(function* () {
    const code = yield* Ref.make(Option.none<ExitCode>())
    const print = printRecord(options.json)
    return yield* options.client.rpc['run.watchEvents']({
      project: options.project,
      run: options.run,
      resume: Option.none(),
    }).pipe(
      Stream.flatMap(item => Stream.fromIterable(item.value)),
      Stream.runForEach(event =>
        Effect.andThen(
          print(event),
          event.kind === 'end'
            ? Ref.set(code, Option.some(event.code))
            : Effect.void,
        ),
      ),
      Effect.andThen(
        Effect.map(
          Ref.get(code),
          Option.match({
            onNone: () => Followed.Unended(),
            onSome: ended => Followed.Ended({ code: ended }),
          }),
        ),
      ),
      Effect.catchTags({
        NoRun: () => Effect.succeed(Followed.NoRun()),
        RunNotFound: ({ run }) =>
          Effect.fail(refused(`the project has no run ${sanitiseLine(run)}`)),
        ProjectNotFound: ({ project }) =>
          Effect.fail(
            refused(`the engine has no project ${sanitiseLine(project)}`),
          ),
      }),
    )
  })

export const follow = Command.make(
  'follow',
  { project: projectFlag },
  ({ project }) =>
    Effect.flatMap(Json, json =>
      withProject(project, (client, id) =>
        Effect.flatMap(
          followRun({ client, project: id, run: Option.none(), json }),
          Followed.$match({
            Ended: () => Effect.void,
            Unended: () => Effect.void,
            NoRun: () =>
              Effect.fail(
                refused(
                  `no run is going in ${sanitiseLine(id)}: start one with \`fabrica run\``,
                ),
              ),
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("The run's events as plain lines"))
