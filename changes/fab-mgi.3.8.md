- The engine keeps model credentials by name in the host's secret store (`packages/engine/src/secrets`): the
  macOS Keychain through `security`, libsecret through `secret-tool` or KWallet through `kwallet-query` on
  Linux, each reached through its CLI with the secret on stdin, never on a command line; on a host where no
  keyring answers, an AES-256-GCM file at `<data>/secrets/credentials.enc` (mode 0600), its key derived by
  scrypt from a passphrase given at the start or read from a file only its user can read, with a warning.
  An API key may be a command whose output is the key, run each time the key is needed. Credentials are
  `Redacted` throughout, and no error carries one.
