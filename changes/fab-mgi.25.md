- A watched stream no longer waits for ever for a reconnect that won't come: when the client's `reconnect`
  schedule ends after a lost connection (the CLI's over SSH stops when ssh is refused), its link is `Lost`
  and the stream ends with the connection's loss; the console takes it as a failed attempt and connects
  again. A frame the client can't read, which leaves the connection open, ends the stream with the defect.
