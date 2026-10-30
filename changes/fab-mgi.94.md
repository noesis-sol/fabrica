- A stream that a frame the client can't read ends is now ended at the engine too: the client sends the engine
  an interrupt for every request a protocol error fails, where before the engine's side of a watched stream ran
  on for as long as the connection lasted. A request made just as such an error fails the ones in flight is no
  longer failed with it.
