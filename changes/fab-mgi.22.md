- Git's network commands get the host's whole transport (spec §11.7, §20.2): beside the ssh-agent, the
  host's own `GIT_SSH_COMMAND` and `GIT_SSH_VARIANT` (run as they are, git ranking them over the engine's
  batch-mode ssh, now given as `-c core.sshCommand`), curl's proxies and the CA certificates. Nothing that
  would ask (`SSH_ASKPASS`, `GIT_ASKPASS`, `DISPLAY`) is passed, nor `GIT_SSH`; no agent's or check's
  command gets any of them.
