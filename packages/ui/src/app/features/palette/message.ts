import { Schema } from 'effect'

import * as Palette from '../../../screens/palette'

// The command palette's Messages (spec §18.5).

export const messages = {
  RequestedPalette: {},
  /** A Message of the command palette's: its query changed. */
  GotPaletteMessage: { message: Palette.Message },
  /** The palette's selection moved `by` places. */
  MovedPaletteSelection: { by: Schema.Int },
  /** The palette's selected entry run: Enter in its search field. */
  RanPaletteSelection: {},
  /** The palette's entry `id` run: a click on it. */
  RanPaletteEntry: { id: Schema.String },
}
