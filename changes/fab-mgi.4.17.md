- Keeping awake and the battery (spec §7.7, H67): `keepAwake` holds an idle-sleep inhibitor in a run's
  scope (`caffeinate -i -w <engine pid>` on macOS, `systemd-inhibit --what=idle` over `tail --pid=<engine
  pid>` on Linux), ended with its tree as the run ends, unless `keep_awake` is false and the run isn't
  overnight; it does nothing where the host has no inhibitor. The `Battery` service reads the host's power
  (`pmset -g batt` on macOS, `/sys/class/power_supply` on Linux), and `watchBattery` says, as a run starts,
  that a closed lid still sleeps a host with a battery and that it is on battery, then reads it once a
  minute and warns at 20% and at 10% while discharging, a threshold warned of again once the charge has
  risen above it. `recordBattery` writes these as `warn` (`LID_SLEEPS:`) and `battery` records with their
  lines; `batteryBanner` gives the run view's banner and `batteryNotifies` the notification at 10%.
