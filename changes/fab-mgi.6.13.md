- A connection over ssh, WSL2 or the app's relay opens only once the engine is reached, so a prompt held past
  10 s (a host key's fingerprint compared, a passphrase looked up, a security key's touch) or a cold engine's
  start no longer fails it on the RPC's missed ping: the relay says `Opened` once its own engine connection is
  open, the page's open waits for it, and a bridge's open says a ping and waits for the first byte back or its
  end, for 60 s at most with the time ssh waits on a person left out (on the terminal, all of it).
