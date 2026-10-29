import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('fabrica', {
  versions: { electron: process.versions['electron'] },
})
