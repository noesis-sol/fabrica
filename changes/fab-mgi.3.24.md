- The `fabrica` CLI has its frame (spec §19), on Effect's `effect/cli`: every command group of §19 is
  registered, each in its own file under `apps/engine/src/cli/`, and those not built yet say so and fail.
  `fabrica engine status|stop|version` talk to the engine; `--json` (an answer's schema encoding, one line)
  and `--engine <name>` (`-e`; only `local`, the local engine's socket, is known yet) are taken by every
  command; flags take two dashes, shorthands one.
- Everything the CLI prints, `--json`, the help and its errors included, is sanitised for the terminal: C0
  controls (escape sequences with them), DEL, C1 controls, bidi embeddings, overrides and isolates, and the
  line and paragraph separators are shown as `\uXXXX` escapes, so JSON output still parses.
