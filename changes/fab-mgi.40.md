- A project's trust (spec §12.1, §20.2): engine.db keeps whether the user trusts each project (migration
  `0002_project_trust`, every project untrusted until then), `Projects.setTrusted` sets it, and an agent of a
  trusted project starts with `FABRICA_PROJECT_TRUSTED=1` (`AgentStart.projectTrusted`), so the first-party
  extension lets Pi load the project's own settings and packages; the caller's variables never set it.
