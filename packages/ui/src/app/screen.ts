import { defineTaggedUnion } from 'foldkit/schema'

import { TicketId } from '@fabrica/contracts'

import { EngineProject } from './engine-project'

// The app's screens (spec §18.3, §18.4): the console, and the screens reached from it (a card, a
// project, the command palette). The screen shown is the Model's; routing is setting it, so the app
// opens on the console and goes back to it from anywhere.

export const Screen = defineTaggedUnion({
  Console: {},
  /** A worker's view, on its project: its ticket, its live figures, its transcript and its composer. */
  Worker: { project: EngineProject, ticket: TicketId },
  Talks: {},
  Backlog: {},
  Review: {},
  Insights: {},
  Engines: {},
  Settings: {},
})
export type Screen = typeof Screen.Type

/** A screen's name, as navigation, the key help and the palette say it. */
export const screenTitle = (screen: Screen): string =>
  Screen.match(screen, {
    Console: () => 'Console',
    Worker: ({ ticket }) => `Worker ${ticket}`,
    Talks: () => 'Talks',
    Backlog: () => 'Backlog',
    Review: () => 'Review',
    Insights: () => 'Insights',
    Engines: () => 'Engines and projects',
    Settings: () => 'Settings',
  })
