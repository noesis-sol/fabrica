- The engine update's install tests no longer wait on macOS's first run of each launcher they unpack, which
  XProtect scans one file at a time for the whole machine (150-190 ms each, 2.4 s behind 16 others). The fixture
  Updater reads a launcher through `/bin/sh`; one new test, `update-launcher-exec.test.ts`, still execs it.
