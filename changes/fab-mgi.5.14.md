- The app's system notifications (spec §18.5): a question or a permission request that arrives, a run's end
  (with how it ended), a hold on something outside the run (environment, usage limit, credentials, budget) and
  the battery at 10% each show one notification, while the app's window doesn't have focus. What was already
  open when the app started listening tells nothing, nor does a question the run's `--auto-answer` answers at
  once. The renderer decides what to tell (`packages/ui/src/app/notify.ts`, from every project's attention
  requests and each running project's run events) and asks main through the preload's `notify`, validated with
  Schema on both sides; main shows it (`apps/desktop/src/main/notifications.ts`). Clicking one brings the
  window forward, made again if it was closed, and the console shows its target: the request, focused, or the
  project's run, moving the scope to that project unless it already shows it.
