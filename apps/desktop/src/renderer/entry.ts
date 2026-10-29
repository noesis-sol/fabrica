import { notifierOf, start } from '@fabrica/ui'
import '@fabrica/ui/styles.css'

import type { FabricaApi } from '../preload/api'

declare global {
  interface Window {
    /** The preload's API (spec §20.1). */
    readonly fabrica: FabricaApi
  }
}

start(window, notifierOf(window.fabrica.notifications))
