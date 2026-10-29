import { Runtime } from 'foldkit'

import { Message, Model, init, update, view } from '@fabrica/ui'
import '@fabrica/ui/styles.css'
import { applyTheme, defaultTheme } from '@fabrica/ui/theme'

applyTheme(document.documentElement, defaultTheme)

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
})

Runtime.run(application)
