- Remote engines are reached through the SSH stdio bridge: the system's `ssh <destination> fabrica bridge`,
  one ssh process per connection, with the user's config, keys and agent, keepalives, and nothing
  forwarded. A lost link runs ssh again and the client resumes its streams; a changed host key, an unknown
  one not accepted, a failed sign-in or a host without `fabrica` is refused and said in words, and not tried
  again. ssh's prompts (an unknown host's fingerprint, a passphrase, a password) can be relayed to the
  caller through `SSH_ASKPASS`, which takes OpenSSH 8.4 or later. The CLI takes
  `--engine ssh://[user@]host[:port]`, ssh asking on the terminal; the app's connection process takes an
  SSH target, asking nothing yet. A CI workflow (`remote-e2e.yml`) reaches an engine in a container
  through the bridge.
