- The gate's decisions are counted per ticket (§12.6): each is recorded as a telemetry row with why it asked or
  refused, and read back by `gate.counts`, shown beside a ticket's or a run's diff on the Review screen, and by the
  named query `gate_decisions` (`fabrica insights gate_decisions`, a panel of the Insights screen). A permission
  request's wait now reaches the `waits` query. A reason never leaves in an export.
