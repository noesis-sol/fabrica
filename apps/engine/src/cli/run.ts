import {
  notYetGroup,
  optionalValueFlag,
  switchFlag,
  valueFlag,
} from './not-yet'

// `fabrica run [--tickets|--ticket <id>|--spec <file|url> [--refine]|--feature "<text>"|--overnight] …`
// and `fabrica run status|drain|undrain|stop` (spec §19, §13): starting a run, and a run.

export const run = notYetGroup({
  name: 'run',
  description: 'Starts a run',
  starts: {
    tickets: switchFlag('tickets'),
    ticket: valueFlag('ticket'),
    spec: valueFlag('spec'),
    refine: switchFlag('refine'),
    feature: valueFlag('feature'),
    overnight: switchFlag('overnight'),
    limit: valueFlag('limit'),
    concurrent: valueFlag('concurrent'),
    model: valueFlag('model'),
    autoAnswer: optionalValueFlag('auto-answer'),
    offline: switchFlag('offline'),
    wait: switchFlag('wait'),
  },
  commands: [
    ['status', "The run's state"],
    ['drain', 'Starts no more tickets; the ones running finish'],
    ['undrain', 'Starts tickets again'],
    ['stop', 'Stops the run'],
  ],
})
