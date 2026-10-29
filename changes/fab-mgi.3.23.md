- `@fabrica/client` has the engine client (spec §8): `EngineClient` runs Effect RPC (`effect/rpc`) over a
  transport's `Socket` with NDJSON frames, says hello (`engine.connect`) at its start and again on every
  connection it reopens after a lost one, and reports a version the engine won't speak as
  `VersionMismatch`, naming the side to update. Its `link` says whether it is up, reconnecting or refused.
- `watch` resumes a stream after a reconnect from the last sequence number it took, takes the new snapshot
  the engine sends when it is too far behind or the engine restarted, and subscribes afresh when a patch
  skips a number (§8.3).
- Transports: `layerMemory` (a client socket and an engine `SocketServer` in one process, whose `drop`
  cuts every connection), and in `@fabrica/client/node` the engine's local socket (`layerUnixSocket`) and
  a bridge command's stdio (`layerBridge`, the shape of the SSH and WSL2 bridges, §8.2).
