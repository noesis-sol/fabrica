- The Backlog screen has a Merge conflicts section: each field a sync's merge kept one side of, its ticket, the
  value kept and the other value, and "Use the other value", which sets the field to the other value through
  `tickets.update`. The engine's new `tickets.conflicts` gives the conflicts still open: a later change of the
  field closes one. A value `tickets.update` can't set (an assignee, a close) is shown without the button. The
  section stays empty until sync records the conflicts.
