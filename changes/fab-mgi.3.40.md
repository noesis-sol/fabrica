- The Linux secret store reaches KWallet through the Secret Service it serves, as GNOME Keyring's, by
  `secret-tool`: `kwallet-query` can't make a folder or an entry, and exited 0 from writes it dropped. An item
  in a locked keyring is told from a missing one (`secret-tool search` still lists it) and fails as locked; a
  credential longer than `secret-tool store` keeps whole (8,191 bytes in base64) is refused rather than cut;
  a Keychain `security` may not ask to unlock, as over SSH, says so.
