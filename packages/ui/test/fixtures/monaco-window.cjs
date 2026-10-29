// The window the Monaco diff test (test/monaco-diff.test.ts) loads its page in: Electron's, hidden,
// its page confined as the app's is (apps/desktop/src/main/window.ts): sandboxed, isolated, with web
// security on, so a worker or a font the app's page can't load from its file can't load here either.
const { BrowserWindow, app } = require('electron')

app.dock?.hide()

app.whenReady().then(() =>
  new BrowserWindow({
    show: false,
    width: 1024,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }).loadURL('about:blank'),
)
