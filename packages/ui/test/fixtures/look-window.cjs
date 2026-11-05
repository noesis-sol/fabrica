// The window the look test draws the console scene in (test/look.test.ts): Electron's, as the app's,
// hidden but on Linux, and sized by the test, which starts Electron at one pixel to a CSS pixel.
const { BrowserWindow, app } = require('electron')

app.dock?.hide()

app.whenReady().then(() =>
  new BrowserWindow({
    // Under Xvfb a hidden window is neither resized nor drawn, so the test's size and screenshot never come.
    show: process.platform === 'linux',
    useContentSize: true,
    width: 1280,
    height: 800,
  }).loadURL('about:blank'),
)
