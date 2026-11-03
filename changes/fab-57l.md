- `fabrica serve` takes the secret store's passphrase on a host with no keyring: typed at a prompt on the
  terminal, asked only once no keyring answers and twice for a new file, or read from `--passphrase-file`
  (mode 0600), which `fabrica service install --passphrase-file` gives the login service's `serve` and an
  update's restart gives the new engine. Without either, runs are refused, saying a passphrase is needed.
