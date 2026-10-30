- The app has its own icon in place of Electron's: the title bar's CORES meter in Lichen Bright, a 3 × 3 grid
  whose busy blocks make an F, drawn by `apps/desktop/build/icon.ts` into `build/icon-mac.png` (on Apple's
  icon grid, made into the icns) and `build/icon.png` (Linux's icon and Windows's ico), which
  `electron-builder.yml` names for each platform.
- A packaged app keeps its own data (Chromium's storage, the theme its window opens in) in a folder named
  after it rather than after its package, `@fabrica/desktop`: `~/Library/Application
  Support/solutions.noesis.fabrica` on macOS, apart from the engine's `fabrica` on a case-insensitive disk,
  `~/.config/Fabrica` on Linux and `%APPDATA%\Fabrica` on Windows. A development build keeps Electron's.
