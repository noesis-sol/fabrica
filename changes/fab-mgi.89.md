- The release publishes the app with the engine: `.github/workflows/release.yml` packages it on its five
  targets through `app.yml` (now callable with the commit and the engine to embed), each embedding the
  release's own engine archives, the notarised ones for macOS, and the Windows app the engine's signed
  `checksums.txt`; it attaches the dmg, zip, AppImage, deb, rpm, NSIS installer, blockmaps and update feeds
  (`latest*.yml`) to the GitHub Release, their sums in the signed `checksums.txt` and their provenance
  attested, so an installed app finds its updates. The two macOS runs' `latest-mac.yml` are merged into one
  listing both zips (`scripts/mac-feed.ts`), from which electron-updater picks a Mac's architecture.
- `node scripts/release-notes.ts --gather X.Y.Z` sets `apps/desktop/package.json`'s version too, which the
  app's installers carry and electron-updater compares; the release refuses a commit whose app version isn't
  the release's. A release needs the Apple secrets for the app as for the engine; without the Windows
  certificate the Windows app is published unsigned, with a warning.
