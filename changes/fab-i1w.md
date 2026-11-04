- The run view's projection reads what each earlier step says once per write, where it read it for every step
  against every earlier one: a run with hundreds of steps under way spent seconds on each write.
- The tests that failed and passed on their rerun under load have more time: whole-run tests 60 s, the install
  script's 30 s, and the daemon's test of two engines taking the lock 30 s. They ran past the limit with nothing wrong.
- The Pi agent tests wait for the stub's log by looking at it, where a file watch on macOS can miss the line: a
  test of an interrupted start then waited out the handshake's limit, and interrupted a start already failed.
