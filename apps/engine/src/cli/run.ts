import { notYetGroup } from './not-yet'

// `fabrica run [--tickets|--ticket <id>|--spec <file|url> [--refine]|--feature "<text>"|--overnight] …`
// and `fabrica run status|drain|undrain|stop` (spec §19, §13): starting a run, and a run.

export const run = notYetGroup({
  name: 'run',
  description: 'Starts a run',
  starts: true,
  commands: [
    ['status', "The run's state"],
    ['drain', 'Starts no more tickets; the ones running finish'],
    ['undrain', 'Starts tickets again'],
    ['stop', 'Stops the run'],
  ],
})
