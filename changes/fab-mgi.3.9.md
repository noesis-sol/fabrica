- `packages/engine/src/workgraph` is the work graph's tracker interface and its local SQLite store (spec
  §11.1, §11.2): the `WorkGraph` service, every operation of §11.1 (`ready` and `why` fail as not built
  until the ready rule's ticket fills `ready.ts`), on `@effect/sql-sqlite-node` (`node:sqlite`, WAL, one
  serialised connection, a 5 s busy timeout, foreign keys on). Migrations are bundled with `fromRecord`;
  a database holding a schema is backed up to `<file>.v<version>.backup` before it is migrated, and one
  a newer engine migrated is refused (`DatabaseTooNew`). Each mutation runs in one transaction with the
  `events` row it appends, naming its actor; `blocks` and `parent` edges that would close a cycle are
  refused; a deletion leaves a tombstone and keeps the ticket's history. Ticket IDs are
  `<prefix>-<11 base36 characters>` (spike fab-mgi.2.3), children `<parent>.<n>`, never reusing a
  deleted child's. `list` reads in batches that yield; `changes` subscribes to the events appended,
  through `sql.reactiveMailbox`. Beyond §11.2's schema: a question's `consequential` and
  `maintainer_only` columns, and a `tombstones` table.
- `@effect/sql-sqlite-node` 4.0.0 joins the engine's dependencies, held to the Effect version by
  `overrides`.
