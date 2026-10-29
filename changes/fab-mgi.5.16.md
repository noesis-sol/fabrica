- The Review screen (spec §18.4, `packages/ui/src/screens/review.ts`): a ticket's branch diff (`diff.ticket`)
  and a run's merged diff (`diff.run`), the changed files listed and each shown in Monaco's diff view, side by
  side and read-only, its two sides rebuilt from the patch's hunks, each under its header line; a file Monaco
  can't draw (a binary file, a view that failed) shown as its patch. The project's last run report
  (`report.get`), which opens its run's merged diff, and the last 400 lines of its human log (`log.tail`), read
  again on request. A set-aside ticket's Review card opens its branch diff; reached from navigation, the screen
  shows the scope's report, its log and the run going's diff, follows the scope, and asks again once the
  engine is reached. Keys D, R and L show the diff, the report and the log.
- Monaco (`monaco-editor` 0.57.0) is loaded the first time a diff is shown, with its editor worker and its
  basic languages' syntax colours only, in a theme made from themes.css's tokens (`packages/ui/src/mounts`).
