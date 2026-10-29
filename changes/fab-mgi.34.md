- The untracked files the merge queue's setups and checks write in a ticket's worktree are recorded in its own
  git folder (`fabrica-wrote`) however the setup or check ends: a failed or timed-out check's, a failed
  setup's, a ride's, and one a stop cut short. `enter` doesn't take them for the worker's, so a ticket that comes
  back to the queue isn't refused as `CLOSED_UNCOMMITTED` for files its worker never wrote, nor a rider whose
  ride's check wrote a report, and `CLOSED_UNCOMMITTED` names the worker's files alone. A ticket set aside has
  them removed (`Git.removeUntracked`, never a tracked or ignored file) before it goes back to its worker.
