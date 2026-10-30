import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'

import type { Handlers } from '../../feature'
import type { Model } from '../../model'
import { ShowTheme } from '../../theme-host'
import type { messages } from './message'

// The theme (spec §18.2): one chosen is applied at once, and kept as the install's.

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ChoseTheme: ({ theme }) => ({
    model: modifyFields(model, { theme: () => Option.some(theme) }),
    commands: [ShowTheme({ theme })],
  }),
  CompletedShowTheme: () => ({ model }),
})
