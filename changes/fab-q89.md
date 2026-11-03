- The tests of the restart into an update no longer time out on a loaded Mac. Their stand-in launcher is
  `/bin/sh` on a script, since a freshly written executable's first run waits on macOS (850 ms and up, with
  how many start together), and they read what it said from a FIFO, which can't be missed. The three test
  files share it, `packages/engine/test/fixture-launcher.ts`.
