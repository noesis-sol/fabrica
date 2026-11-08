- A pull now keeps the last push after it has imported the fetched commit, not before. Were it kept first, a
  crash between the two left `lastPushed` at a commit the store had never imported; a later clone, which loses
  `lastImported`, then rescanned from that commit and wrote the store's stale values over the merge at their old
  clocks, dropping the other engine's edit with the engines converged and no conflict recorded (§11.4, §11.7).
