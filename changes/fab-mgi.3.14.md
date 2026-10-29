- `packages/engine/src/settings` resolves a run's settings once (spec §13.13): each key from its flag
  (`--verifier-rounds`), else its `FABRICA_` variable (`FABRICA_VERIFIER_ROUNDS`), else
  `.fabrica/settings.json` (read through the hostile-file reader) for a project key or the engine's
  settings for a machine key, else its default; a group such as `verifier` is merged key by key. Every
  problem in every source is listed together, each with where it was given; a person's or a machine's
  setting in the project's file is one (H68). Each value's source is kept for the Settings screen.
  Writing a key edits only its value, or adds it beside its neighbours with their indentation and
  line endings, or removes it with its comma, keeping the rest of the file as written (§16).
