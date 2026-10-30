- A ride on the merge train stands for its rider's turn only when its check passed. A ride whose check
  failed, timed out or couldn't run, or whose setup failed, says nothing of the ticket, as it ran beside
  another check: its branch is put back and its own turn rebases, sets it up and checks it again, rather
  than setting it aside `CHECKS_FAILED` or `SETUP_FAILED` on the ride's outcome.
