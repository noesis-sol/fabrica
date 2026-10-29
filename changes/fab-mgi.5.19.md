- The console's look test (spec §18.2, §24), `packages/ui/test/look.test.ts`: the console scene with fixture
  data close to the handoff's (`packages/ui/test/fixtures/console-scene.ts`) is drawn in Electron, through
  Playwright's Electron support, in each theme at the handoff's 1280 × 800 window, and compared with
  `design/console/reference.png` and `kits.png`: the parts' geometry within a pixel, and each part's pixels
  within a 5% tolerance, with the spec's own departures masked. The differences beyond it are filed and held
  as known (fab-mgi.67 to .70, and fab-mgi.7.13 for the run talk). Each run writes the captures, the
  references, each part side by side and a report to `packages/ui/look-captures/`, which CI keeps as an
  artifact. The requires list checks Electron's binary, and on Linux Xvfb, under which
  `scripts/check-fast.sh` runs its suites where there is no display.
