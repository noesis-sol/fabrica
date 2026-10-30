- A keyring CLI and a key's command get the host's sessions: the desktop session's D-Bus bus and display, so
  `secret-tool` reaches the Secret Service outside a systemd user bus, and the password managers' sessions and
  stores (1Password's `OP_*`, `BW_SESSION`, `PASSWORD_STORE_DIR`, `GNUPGHOME`), so `op read` and `bw get` work.
