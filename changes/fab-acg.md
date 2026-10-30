- Each UI and desktop feature registers in files of its own: a UI feature's Messages, update branches, view
  and subscriptions under `packages/ui/src/app/features/<name>/`, a desktop feature's IPC channels and actions
  in `apps/desktop/src/main/features/<name>.ts`; the root's message, update, view and subscriptions files and
  main's index only list them, a line each, sorted by name, so features worked on side by side merge apart.
