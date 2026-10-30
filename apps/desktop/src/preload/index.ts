import { contextBridge, ipcRenderer } from 'electron'

import {
  type PreloadIpc,
  forwardEnginePorts,
  forwardRemoteEnginePorts,
  makeApi,
} from './api'

// The preload (spec §20.1): it runs sandboxed, beside a page isolated from it, and gives the page
// `window.fabrica`, the API of ./api, and the engine ports as window messages.

const ipc: PreloadIpc = {
  send: (channel, ...values) => ipcRenderer.send(channel, ...values),
  invoke: (channel, ...values) => ipcRenderer.invoke(channel, ...values),
  on: (channel, listener) => {
    const onMessage = (event: Electron.IpcRendererEvent, value: unknown) =>
      listener(value, event.ports)
    ipcRenderer.on(channel, onMessage)
    return () => {
      ipcRenderer.off(channel, onMessage)
    }
  },
}

contextBridge.exposeInMainWorld('fabrica', makeApi(ipc))

// The page and the preload share the window's message queue, not their globals: the page's
// onEnginePorts and onRemoteEnginePorts take each port from these messages.
forwardEnginePorts(ipc, (message, ports) =>
  window.postMessage(message, '*', ports),
)
forwardRemoteEnginePorts(ipc, (message, ports) =>
  window.postMessage(message, '*', ports),
)
