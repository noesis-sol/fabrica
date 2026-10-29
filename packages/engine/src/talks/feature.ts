import { Effect, Option } from 'effect'

import type { TalkModeOf } from './core'
import { fileTreeTool } from './file-tree'

// The feature talk (spec §15.4): a feature talked through with the maintainer, then filed as an epic
// and its tickets, which the run takes up (`--feature "<text>"`). Opened with the feature's text, it
// starts on it; opened without, it waits for the maintainer's first message.

export const featureInstructions = [
  "You are talking a feature through with the maintainer, in the project's checkout, which you read but never change.",
  'Find out what the feature is for and what it must do. Read the code it touches, so that you ask only what the code cannot tell you, and raise the decisions it needs one at a time, each with its options and your recommendation.',
  'When the maintainer agrees, file it with file_tree, once: an epic for the feature, and the tickets under it (epics under it for its parts where it has several). Each ticket is one session of work: its description opens with the detail and names the files it will change, and a decision made in this talk goes into the design of each ticket it concerns, since their workers never see this talk. Make a ticket wait on another only where it builds on that work, so that many run side by side.',
  "Once it is filed, give the maintainer the epic's ID: the run takes its tickets up.",
].join('\n\n')

export const featureMode: TalkModeOf<'feature'> = {
  keep: false,
  instructions: featureInstructions,
  tools: [fileTreeTool<'feature'>(() => Option.none())],
  opening: ({ context }) =>
    Effect.succeed(
      Option.map(
        context.text,
        text => `Talk this feature through with me, then file it: ${text}`,
      ),
    ),
}
