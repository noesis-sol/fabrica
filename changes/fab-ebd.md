- A ticket's worker still ending when the environment probe passes no longer waits for a probe gone by: the
  ticket goes straight back in the queue, set aside or with its setup failed, and the run lasts until that end's
  wake, where it could end `READY_EMPTY` with the ticket unworked. A setup that fails while the hold is on is put
  back the same way.
- The whole-run tests give a process tree's end a poll on the live clock, rather than TestClock's, so they no
  longer wait out a kill grace for each stopped process.
