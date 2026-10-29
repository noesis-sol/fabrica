- The console's title bar (`packages/ui/src/console/titlebar.ts`): "Fabrica", the engine host's MEM, CPU and
  CORES from its load stream (MEM's bar `c2` under memory pressure and `c3` when critical, CPU's `c2` past 1.5×
  the cores and `c3` past 3×, each warning also said in a word, "high" or "critical"), one block per core with
  the busy ones in `c1`, and on hover swapping, the merge check's memory and each worker's. The selected
  project's usage windows as the provider's apps name them (`Current usage ━━━─────  41% · This week 12%`),
  the tighter one with its box-drawing meter and alone in a window narrower than 1200px, left out while the
  run holds on a usage limit. The bar is the window's drag region and its search field and stats aren't
  (`data-app-region`, applied by `titlebar.css`); the system's window controls keep their room.
- `@fabrica/contracts` has `UsageWindow`, a provider account's usage window as the model proxy reads it; the
  renderer's Model keeps the scoped project's windows, which a later ticket serves over the connection.
