- The predictor: with more than one slot free, a ready ticket whose text names no files waits in the queue while
  a model guesses the files it will change from the ticket and the repository's file list (tests left out unless
  the ticket mentions tests). The guess is kept as `predicted_files`, which its footprint reads. A ticket with
  commits on its branch is skipped, and a guess lost goes on without one, logged.
