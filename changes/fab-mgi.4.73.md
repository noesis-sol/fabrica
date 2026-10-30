- The model proxy lets go of a call the agent drops before the provider's head has come (Pi's abort, or an
  agent ended mid-call): it aborts the upstream request and releases the call's permit, where it held both for
  good; a call dropped while it waits for its permit stops waiting.
