- A worker's `.fabrica/worker-rules.md` is read as a hostile file (§20.2, H62): without following a link, never
  waiting on a named pipe, only a regular file of at most 64 KiB, under a `.fabrica` that is a real folder, so a
  committed link to a key no longer puts it in every worker's system prompt, and a pipe or `/dev/zero` no longer
  hangs `before_agent_start`.
