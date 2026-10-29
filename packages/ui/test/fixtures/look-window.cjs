// The window the look test draws the console scene in (test/look.test.ts): Electron's, as the app's,
// hidden, and sized by the test, which starts Electron at one pixel to a CSS pixel.
const { BrowserWindow, app } = require('electron')

app.dock?.hide()

app.whenReady().then(() =>
  new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1280,
    height: 800,
  }).loadURL('about:blank'),
)
