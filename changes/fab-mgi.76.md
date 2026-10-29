- `fabrica engine status` says where the engine listens over TLS and its certificate's SHA-256 fingerprint, the
  one the app shows at the first pairing, so the user can compare the two on the host; an engine that listens on
  its local socket only says so. `EngineStatus` carries them as `listening` (`null` where it doesn't listen).
