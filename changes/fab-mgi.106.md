- The release's update test covers the Windows and macOS apps as well as Linux's AppImage: its `update`
  job runs on Linux x64, Windows x64 and each macOS architecture, each on its target's newest earlier app
  (`scripts/earlier-app.ts` takes the target). The Windows app is installed silently from the earlier
  release's NSIS installer, and the test waits for the update's silent installer to end before launching it
  again; the macOS app is unpacked from the earlier release's zip, and the test waits for Squirrel.Mac to
  have the update before quitting, then for ShipIt to put the new release in place. A macOS target says why
  and tests nothing where the release isn't notarised or the earlier app isn't signed with a Developer ID.
