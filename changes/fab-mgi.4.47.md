- `packages/client`: a graceful engine stop (SIGTERM, `engine.stop`, an update's restart) is a lost connection
  the next engine mends. Effect's RPC server interrupts every request in flight as it stops and answers each
  with the interrupt; the client now fails such a request or stream with an `RpcClientError` whose reason is a
  `SocketCloseError` (1001), not a defect, so a watched stream resumes from its cursor after the reconnect and
  a request's caller catches the loss, rather than both being interrupted. The client's own close still
  interrupts what it has in flight (spec §8.3, §9.2).
