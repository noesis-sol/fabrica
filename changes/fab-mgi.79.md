- The engine distribution carries DuckDB (spec §21, §22.4): `@duckdb/node-api` 1.5.6-r.2, `@duckdb/node-bindings`
  and detect-libc, copied beside the bundle into `lib/engine/node_modules` as pnpm laid them out, with the
  target's native package (`@duckdb/node-bindings-<platform>-<arch>`, glibc's on Linux). pnpm installs only the
  host's, so the build fetches the target's from npm's registry at the version `@duckdb/node-bindings` names,
  checks it against pnpm-lock.yaml's sha512 integrity, and keeps it in the download cache beside Node's archive.
  `fabrica insights` answers from an unpacked distribution, where it said DuckDB couldn't be loaded.
- `pnpm --filter @fabrica/engine-app dist` prints DuckDB's part of each unpacked distribution, and counts a
  linked package once: Node 26's recursive `readdir` follows links to folders, and counted each package pnpm
  links twice. Sizes at Fabrica 0.0.0 (§22.5): 97.6 MB (darwin-arm64), 99.1 MB (darwin-x64), 89.8 MB
  (linux-x64) and 87.1 MB (linux-arm64) as archives; 330.4, 333.1, 286.9 and 279.4 MB unpacked, of which
  DuckDB 118.1, 118.0, 71.6 and 64.0 MB.
