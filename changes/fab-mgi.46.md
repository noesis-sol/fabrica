- The renderer takes every engine port main hands it, not only a page load's first: the newest is held
  (`packages/ui/src/app/engine-ports.ts`), and one that comes after the connection took its port, as after
  the connection process is started again, acquires the connection again over it, so the page reconnects
  without a reload. A connection the engine refused still waits for an update.
