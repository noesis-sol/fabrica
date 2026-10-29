import { notYetGroup } from './not-yet'

// `fabrica token create|list|revoke` (spec §19, §9.3): pairing tokens for clients reaching the engine over TLS.

export const token = notYetGroup({
  name: 'token',
  description: 'Pairing tokens',
  commands: [
    ['create', 'Creates a pairing token'],
    ['list', 'The pairing tokens'],
    ['revoke', 'Revokes a pairing token'],
  ],
})
