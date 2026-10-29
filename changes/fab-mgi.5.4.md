- The renderer has its root in `packages/ui/src/app`: one Model (the screen, an overlay, the sidebar's scope,
  the connection and each stream's latest value), its Messages and update, and the console's frame at the
  handoff's measurements (a 38px title bar, the 260px sidebar, the main column with the stats row, the run talk
  beside the 320px History in a row 156px high, and the two ticket columns). Each console part and each screen
  is a placeholder submodel in `packages/ui/src/console` and `packages/ui/src/screens`, for its own ticket to
  fill. The counter demo is gone, and both entries start the program through `start(window)`.
- The renderer connects to the engine as a ManagedResource: the engine client of `@fabrica/client` over the
  MessagePort the preload hands the page (a window message of type `fabrica:engine-port`), its frames decoded
  with the contracts. A failed attempt is retried after 2 seconds; a refused hello says which side to update.
  The run view, attention, the backlog (while its screen is open) and the host's load are subscriptions, each
  stream's items applied at most once per animation frame.
- Each screen's keys are one command list (`app/keys.ts`), from which its bindings, its hints, the key help (`?`)
  and the command palette (⌘K, or Ctrl+K off macOS) are drawn; ⌘1 to ⌘6 and ⌘, go to the screens, and Escape
  closes an overlay or goes back to the console. Plain keys typed in a text field aren't commands.
