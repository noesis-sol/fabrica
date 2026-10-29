- The app opens one window at the handoff's 1280 × 800, shown once painted in the theme's background. Its
  title bar is the design's 38px bar: on macOS the traffic lights sit inset, centred on it; on Windows and
  Linux the system's buttons are drawn on it in the theme's `--side` and `--fg`, recoloured as the page
  switches theme. A second start of the app shows the first's window.
- The page is sandboxed and isolated, with no Node, no `<webview>` and web security on; its Content Security
  Policy loads only the bundled assets, with no eval, plug-ins, frames or forms. It stays on the app's own
  page: a web link opens in the system browser, anything else goes nowhere, no window opens, and the session
  grants no permission but writing text to the clipboard.
- The preload gives the page `window.fabrica`: the window controls and its theme, the folder picker, the app's
  version and its update status, each value decoded with Schema on both sides of IPC, and only from the
  app's own page. It hands the page the engine port main sends as a `fabrica:engine-port` window message.
- The app keeps the engines it knows in its data folder, written whole, and pairing tokens encrypted with
  safeStorage; on Linux without a keyring, where safeStorage's key is Electron's own, it keeps no token.
- The packaged app's fuses are set in `apps/desktop/build/fuses.ts`, electron-builder's afterPack hook:
  RunAsNode off, cookie encryption, only-load-app-from-asar, and asar integrity on macOS and Windows.
