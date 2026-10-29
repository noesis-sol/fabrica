- The app is packaged with electron-builder (`apps/desktop/electron-builder.yml`,
  `pnpm --filter @fabrica/desktop run package --<arch>`): a dmg and a zip per macOS architecture (hardened
  runtime, every Mach-O signed with the Developer ID and notarised where CI has the secrets), an AppImage, a
  deb and an rpm per Linux architecture, and an NSIS installer for Windows x64 (Authenticode where CI has the
  certificate). The macOS and Linux apps embed their architecture's engine distribution, unpacked, as their
  local engine; the Windows app embeds the Linux x64 release's archive and checksums, to install in WSL2.
  The app carries no node_modules: main bundles everything it imports. Its fuses are flipped before it is
  signed.
- The app updates itself through electron-updater from the public GitHub Releases: the macOS app from its
  zip, the Windows app from its installer and the AppImage; it checks at launch and every six hours,
  downloads an update it finds and installs it as it quits. A deb or rpm, a development build, or the app
  launched with `--no-update-check` doesn't check.
- The app finds the local engine's socket from the home folder the engine and the CLI use (`HOME`), where on
  macOS it used Electron's, which ignores `HOME`.
- CI (`.github/workflows/app.yml`) packages the app on its five targets and smoke-tests every artifact
  (`apps/desktop/test/smoke.test.ts`, Playwright's Electron support): installed or unpacked as a user would,
  the app launches, starts its bundled engine and reaches it, and once closed and the engine stopped leaves
  no process behind.
- `THIRD_PARTY_NOTICES.md` lists every component the app and the engine distribution bundle, with its
  licence; the app carries it and the licence files that travel with their components in `licenses/`.
