- Git's network commands get the host's whole transport (spec §11.7, §20.2): beside the ssh-agent, the
  host's own `GIT_SSH_COMMAND` (run as it is, git ranking it over the engine's batch-mode ssh, now given
  as `-c core.sshCommand`) and, only beside it, its `GIT_SSH_VARIANT`; curl's proxies; and the CA
  certificates. Nothing that would ask (`SSH_ASKPASS`, `GIT_ASKPASS`, `DISPLAY`) is passed, nor `GIT_SSH`;
  no agent's or check's command gets any of them.
