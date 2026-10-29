import { notYetCommand } from './not-yet'

// `fabrica answer [<id>]` (spec §19): questions and permission requests, asked on the terminal with their
// options; the answer talk on the terminal.

export const answer = notYetCommand(
  'answer',
  'Answers questions and permission requests on the terminal',
)
