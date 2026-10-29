import { notYetGroup } from './not-yet'

// `fabrica credentials set|list|remove|login` (spec §19, §20.3): model credentials in the engine's secret
// store.

export const credentials = notYetGroup({
  name: 'credentials',
  description: "Model credentials in the engine's secret store",
  commands: [
    ['set', 'Sets an API key, or a command whose output is the key'],
    ['list', 'The credentials, by name'],
    ['remove', 'Removes a credential'],
    ['login', 'Signs in to a subscription'],
  ],
})
