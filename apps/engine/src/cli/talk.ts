import { notYetGroup } from './not-yet'

// `fabrica talk refine|feature|answer|run` (spec §19, §15): a talk with an agent on the terminal.

export const talk = notYetGroup({
  name: 'talk',
  description: 'A talk on the terminal',
  commands: [
    ['refine', 'Refines a spec into tickets'],
    ['feature', 'Shapes a feature into tickets'],
    ['answer', 'Answers questions in a talk'],
    ['run', 'Talks about a run'],
  ],
})
