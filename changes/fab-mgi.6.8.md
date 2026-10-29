- The TLS listener (spec §9.3, §8.2, §20.2): `fabrica serve --listen <addr>` (`host:port`, `[v6]:port` or
  `:port`), or the engine's `listen` setting, has the engine serve the protocol as a WebSocket over TLS on
  that address too, beside its local socket, through the one RPC server. Its certificate is the user's
  (`--listen-certificate` and `--listen-key`, or the settings of those names, PEM files) or one the engine
  makes once (self-signed, ECDSA P-256) and keeps in its data folder, the key mode 0600; the engine logs its
  SHA-256 fingerprint as it starts. A client presents a pairing token as `Authorization: Bearer <token>` in
  its upgrade request; one with none, or one the engine doesn't hold, is answered 401 and never reaches the
  protocol, and revoking a token closes the connections it opened.
- Pairing tokens: the Hosts and tokens group (`tokens.create`, `tokens.list`, `tokens.revoke`) and
  `fabrica token create <name>|list|revoke <name>`. A token is printed once, as it is made; engine.db keeps
  only its SHA-256 hash and when it was last used; tokens are listed and revoked by name.
- `@fabrica/client/node` has the TLS transport (`layerTls`): it checks the certificate the engine presents
  against the fingerprint pinned at the first pairing (`presentedFingerprint` gives the one to show) before
  it sends anything, and fails with `CertificateChanged` for another; a refused token fails with
  `TokenRefused`.
