import { Effect, Match, Option } from 'effect'

import { TalkNotOpened } from '@fabrica/contracts'

import { readFileBytes } from '../files'
import type { TalkModeOf } from './core'
import { fileTreeTool } from './file-tree'

// The refine talk (spec §15.4, §15.5): a spec in the project, talked through with the maintainer
// before its breakdown, until nothing its breakdown would have to guess is left open; then the talk
// files the tree itself (`--refine` runs it in place of the breakdown organ), each ticket carrying
// the spec and the decisions made in the talk. It opens on the spec, which must be a file in the
// project's checkout.

/** The largest spec the talk opens on, as a spec fetched from a URL is held to (§15.5). */
const specMaxBytes = 5 * 1024 * 1024

export const refineInstructions = [
  "You are refining a spec with the maintainer before it is broken down into tickets. The spec is a file in the project's checkout, which you read but never change.",
  'Read the spec whole first, and the code it builds on. Then raise, one at a time, what its breakdown would otherwise have to guess: gaps, contradictions, decisions it leaves open, requirements it does not state (tools the machine needs, how the checks run). Give each with its options and your recommendation, and keep what the maintainer decides.',
  'When nothing is left open and the maintainer agrees, break the spec down and file the tree with file_tree, once: the root epic for the spec; when the spec needs a tool the machine lacks or the repository has no code, an environment ticket first (labelled solo, priority 0, every other ticket waiting on it) that writes the requirements list and the pins, scaffolds and installs the dependencies; then an epic for each part of the spec, and the tickets under it.',
  'Each ticket is one session of work. Its description opens with the detail and names the sections of the spec it builds; it names the files it will change. A decision made in this talk goes into the design of each ticket it concerns: their workers never see this talk. Make a ticket wait on another only where it builds on that work, so that many run side by side.',
  "Once it is filed, give the maintainer the root epic's ID.",
].join('\n\n')

/** The talk can't be opened on the spec, saying why. */
const notOpened = (reason: string) => new TalkNotOpened({ reason })

export const refineMode: TalkModeOf<'refine'> = {
  keep: false,
  instructions: refineInstructions,
  tools: [fileTreeTool<'refine'>(({ spec }) => Option.some(spec))],
  opening: ({ context: { spec }, project }) =>
    readFileBytes(
      { root: project.path, path: spec },
      { maxBytes: specMaxBytes },
    ).pipe(
      Effect.mapError(error =>
        notOpened(
          Match.value(error).pipe(
            Match.tag(
              'FileMissing',
              () => `the spec ${spec} isn't in the project's checkout`,
            ),
            Match.tag(
              'PathOutsideRoot',
              () => `the spec ${spec} isn't a path in the project`,
            ),
            Match.orElse(
              ({ message }) => `the spec ${spec} can't be read: ${message}`,
            ),
          ),
        ),
      ),
      Effect.as(
        Option.some(
          `Refine the spec ${spec} with me before its breakdown, then file its tree.`,
        ),
      ),
    ),
}
