- The engine reads its host's cores, memory, 1-minute load and home folder through the `Host` service, whose
  live layer (`layerNodeHost` in `@fabrica/engine`) reads `node:os`; `fabrica serve` and `fabrica bridge` take
  their home folder and cores from it, so tests inject them.
