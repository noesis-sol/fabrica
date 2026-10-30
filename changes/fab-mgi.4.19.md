- The Pi contract suite (`packages/pi-extension/test/contract.test.ts`) runs the real pinned Pi in RPC mode,
  started by the engine's `PiAgent` with the first-party extension, against a stub Anthropic provider at the
  base URL `models.json` gives it: the handshake, a call to each worker tool, refused arguments, the gate
  blocking a call, the settle nudge, a session resumed with `switch_session`, and usage reported. Run it on
  every Pi upgrade with `pnpm --filter @fabrica/pi-extension test:contract`.
