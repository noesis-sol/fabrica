- The desktop app pairs with an engine over TLS (spec §9.1, §9.3): Add engine offers "Over TLS" beside "Over
  SSH", taking the engine's TLS address (`host:port`, as `fabrica engine status` prints it), a pairing token
  from `fabrica token create`, and its name (its host's where none is given). The connection process reads the
  fingerprint of the certificate the engine presents there (`fabrica:read-fingerprint`, given up after 15 s)
  and the app shows it to compare; only once the user accepts it does main take the pairing
  (`fabrica:pair-engine`), and only with the fingerprint the connection process read at that address. The
  engine then joins the known engines with its address and pinned fingerprint and is connected to; once its
  first hello comes it is kept in the app's state, and its token in safeStorage. A machine where safeStorage
  can keep no secret (Linux without a keyring) refuses the pairing, saying so.
- The connection process reaches a paired engine with `layerTls`, with the fingerprint and token main's own
  records hold for it, never the page's. A connection whose engine presents another certificate than the one
  pinned, or refuses the token (wrong, or revoked), stops and says so on the engine's card, never tried again
  silently; the card offers Try again and Pair again, which opens the TLS form at its address under its name.
- The client's TLS connection and fingerprint read can be interrupted while they connect, so a timeout gives
  up on an engine that never finishes its handshake.
