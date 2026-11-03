import { Schema } from 'effect'

// The keys' Messages (spec §18.5): a key pressed, and the key help over the screen.

export const messages = {
  /**
   * A key went down anywhere in the window; `inField` while focus is in a text field, `repeat` when it
   * is the system's auto-repeat of a held key.
   */
  PressedKey: {
    key: Schema.String,
    mod: Schema.Boolean,
    alt: Schema.Boolean,
    inField: Schema.Boolean,
    repeat: Schema.Boolean,
  },
  RequestedKeyHelp: {},
  DismissedOverlay: {},
}
