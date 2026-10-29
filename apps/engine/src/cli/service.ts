import { notYetGroup } from './not-yet'

// `fabrica service install|uninstall|status` (spec §19, §7.1): the login service that runs `fabrica serve`.

export const service = notYetGroup({
  name: 'service',
  description: 'The login service',
  commands: [
    ['install', 'Installs the login service that runs the engine'],
    ['uninstall', 'Removes the login service'],
    ['status', "The login service's state"],
  ],
})
