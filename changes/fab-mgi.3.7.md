- `packages/engine` has the wake service (`src/time/`): it reads the wall clock every second and takes a
  gap of more than 15 s for a sleep, published as a `Slept` notification with its span and, on macOS, its
  cause from `pmset -g log`. Deadlines count time awake, so a sleep puts off every one it crosses; those on
  the wall clock (usage-limit resets, leases, sync schedules) are not put off. Durations come from the
  monotonic clock and are never negative, and timestamps are local with their UTC offset.
