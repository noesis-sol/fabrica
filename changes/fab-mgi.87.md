- The console no longer crashes on the engine's `NotImplemented` answers: the client fails a request or stream
  the engine answers with a defect with an `RpcClientError` whose reason is an `RpcClientDefect`, which its
  callers catch, and a watched stream ends with it rather than waiting for a reconnect. The console words it
  as `<rpc> failed: <the defect>`, and the CLI says the engine couldn't answer, rather than that the
  connection was lost.
