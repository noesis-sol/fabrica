- The engine's model proxy (`packages/engine/src/proxy`): a loopback HTTP listener on 127.0.0.1, on an
  ephemeral port, that agents' model calls go through. Each agent's session is granted a token, counted to
  its run, ticket and model and revoked with the session; each call is checked for it, takes a permit (the
  `Permits` service, open to every call until the holds fill it), has the token swapped for the provider's
  credential from the secret store, and has the provider's response streamed back byte for byte, for
  Anthropic Messages, OpenAI Responses and Chat Completions, Google and local models (no credential). The
  proxy reads each call's tokens from the response's final usage and what a refusal means (a 429 with a
  window's reset a `UsageLimited`, one without a `RateLimited`, a refused credential a `StartFailed` until a
  call to its provider has gone through in the run and a `CredentialRefused` after), publishes both as a
  stream, and makes a small probe call per provider for the start checks and the holds.
