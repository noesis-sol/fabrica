- Git's network commands reach the host's ssh-agent (spec §10.1, §10.3): a clone gets the engine's
  `SSH_AUTH_SOCK`, so an SSH URL whose key an agent holds (1Password, the macOS keychain, a forwarded agent)
  clones, and ssh runs with `BatchMode=yes`, failing instead of asking; a host whose git configuration names
  its own ssh command (`core.sshCommand`) has that one run as it is. No agent's, check's or other git command
  gets the socket.
