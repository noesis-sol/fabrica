- The CI, App and Remote e2e workflows pass again. Without signing secrets the Mac app packages unsigned, rather than
  stopping on an empty `CSC_LINK`. The tests that read the runner's core count, its real `podman` or its scrollbars
  no longer do, the AppImage's smoke test has the tools its launcher runs, and the Windows one the
  profile folders Electron needs at its start.
- On Linux the engine no longer keeps what the app had open: an engine an AppImage started held its image mounted
  and its process waiting for as long as the engine ran, after the app had quit.
