- `packages/contracts/src/rpc/` has the client–engine protocol (spec §8), one module per group of §8.1, each
  request, stream and error an Effect Schema in an `RpcGroup` (`effect/rpc`): Engine (with the
  `engine.connect` handshake), Hosts and tokens, Secrets (`credentials.login` streams the sign-in's
  steps), Projects, Backlog (`tickets.why` says what holds a ticket back), Runs, Workers, Attention
  (the first answer wins: a later one gets `AlreadyAnswered`, by whom and when), Talks, Review and
  Insights (named queries with their parameters, no SQL). `FabricaRpcs` merges them.
- Streams send a snapshot, then patches, each with a sequence number and the stream's epoch;
  `planResume` decides between the patches after a client's last number and a new snapshot (§8.3).
  Lists patch by key (`applyKeyedPatch`), leaving the rows a patch doesn't name as they were.
- The run view (`RunView`, `RunViewPatch`, `applyRunViewPatch`): the run's header, totals, ticket rows,
  workers, merge queue, holds, banners, attention requests, the host's load and the engine's steps with
  their start times; a patch names only the parts that changed, the rest keeping their identity.
- The protocol's version (`protocolVersion`, §8.4): `negotiate` takes a client at the engine's version
  or the one before and tells one older, or newer than the engine, which side to update.
- `protocolJsonSchema()` exports the whole protocol as JSON Schema (draft 2020-12) for clients in other
  languages, its named schemas shared in `definitions`.
- `TalkId`, `PermissionId` and `ToolCallId` join the branded IDs.
- A ticket's metadata now encodes to JSON when it has `files`, `spec`, `predicted_files` or
  `result_kind`: its record of other keys no longer covers the engine's keys, whose decoded values
  aren't JSON.
