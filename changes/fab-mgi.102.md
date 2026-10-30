- The engine's RPC and control servers and the Pi extension's control client read NDJSON frames in one pass,
  as the client does since fab-mgi.99: a frame that comes in many reads is searched for its end once, not at
  every read. The reader moved to `@fabrica/contracts` (`ndjson`, `layerNdjson`, `wholeFrames`, `maxFrame`).
