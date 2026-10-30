- An engine restarting into an update outside a login service starts the new `fabrica serve` with its own
  `--listen`, `--listen-certificate` and `--listen-key` flags (the paths made absolute), so its TLS listener
  comes back, and with its own environment rather than a command's allowlist, so the new engine's clones,
  fetches and pushes keep the ssh-agent, the host's ssh command, the proxies and the CA certificates.
