- The release checks that the published app updates itself: once a release is published, its `update` job
  downloads the newest earlier release's Linux x64 AppImage (`scripts/earlier-app.ts` picks it, checked
  against that release's `checksums.txt`), launches it under Xvfb with its update checks on, waits for the
  update to be downloaded, quits, and checks the AppImage launched again is the new release
  (`apps/desktop/test/update-smoke.test.ts`, `pnpm --filter @fabrica/desktop smoke:update`). The job says
  why and tests nothing for a pre-release, a release that isn't GitHub's latest, or before the second
  release that publishes the app. The packaged app's tests share their launch helpers
  (`apps/desktop/test/packaged-app.ts`).
