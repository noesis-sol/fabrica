- Keeping a Linux host awake holds `systemd-inhibit`'s sleep lock as well as its idle lock
  (`--what=idle:sleep`): a desktop's power manager suspends an idle laptop through logind's Suspend, which
  only a sleep lock refuses. An inhibitor that exits within its first second (no logind, a lock refused)
  is no longer counted as holding: the run warns `KEEP_AWAKE_FAILED: … exited at once (exit 1); the host
  may idle-sleep`.
