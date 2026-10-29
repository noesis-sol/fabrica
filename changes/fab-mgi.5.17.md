- The Settings screen (spec §18.4, §13.13): the scoped project's `.fabrica/settings.json`, the engine's settings
  and the app's, every setting by its path with its value and its source (the project's file, the engine's
  settings, this app install, or the default), asked of the engine as the screen opens and again when the
  scope changes. The theme, a setting of each app install (§18.2), is switched there and applied at once:
  `data-theme` on the root, the native window coloured through the preload, and the choice kept in the
  window's storage, which the next start reads (`Message.ChoseTheme`, which the palette can send too).
