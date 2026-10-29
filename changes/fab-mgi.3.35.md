- The engine distribution (spec §22.1): `pnpm --filter @fabrica/engine-app dist [target…|all]` builds, into
  `apps/engine/out`, one `fabrica-<version>-<target>.tar.gz` per engine target (`darwin-x64`, `darwin-arm64`,
  `linux-x64`, `linux-arm64`; this host's by default) and `checksums.txt` over the version's archives. Each
  holds the Node runtime mise.lock pins for the target, downloaded once and checked against its pinned sha256
  (§20.4); the engine bundle (`lib/engine/main.js`, migrations in it); Pi 1.4.0 with the dependencies pnpm
  installed for it from the lockfile (`lib/pi`, source maps and type declarations left out); the first-party
  extension, bundled (`lib/extension/index.js`); and `bin/fabrica`, a shell launcher running the bundled Node
  on the bundle, through any link to it. `apps/engine/src/layout.ts` holds the layout, for the build and the
  engine. Sizes at Fabrica 0.0.0 (§22.5): 61.2 MB (darwin-arm64), 62.7 MB (darwin-x64), 65.8 MB (linux-x64)
  and 65.5 MB (linux-arm64) as archives, 210–213 MB unpacked, Node's binary most of it.
