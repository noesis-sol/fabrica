- The engine serves the Review group (`diff.ticket`, `diff.run`, `report.get`, `log.tail`): a ticket's branch
  diffed file by file against its merge base with Base, a run's merged diff on Base from its start to its last
  merge, a run's report from `.fabrica/reports/<run>.md` (the last run's when none is named) and the human log's
  last lines, read from its end. Diffs go through the Git service's new `diff` read, which never runs a
  repository's external diff or text conversion; reports and the log go through the safe reader, which refuses
  a link planted in their place. A run's `start` record now names Base's commit as the run started.
