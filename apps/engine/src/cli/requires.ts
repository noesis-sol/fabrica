import { notYet, switchFlag } from './not-yet'

// `fabrica requires [--markdown]` (spec §19, §17): the requirements' state.

export const requires = notYet({
  group: [],
  name: 'requires',
  description: "The requirements' state",
  flags: { markdown: switchFlag('markdown') },
})
