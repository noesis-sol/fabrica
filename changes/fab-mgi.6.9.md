- Subscriptions sign in through the engine: `fabrica credentials set|list|remove|login` and sign-in buttons
  beside each engine's credentials, for Claude Pro or Max, ChatGPT, GitHub Copilot and OpenRouter. The engine
  runs `pi-ai`'s sign-in, keeps it in its secret store, and relays the page to open, the code to enter and
  what it asks to the client that asked, so a remote engine signs in from the laptop's browser. Every sign-in
  says that a provider's terms are the user's to check.
- The model proxy refreshes a subscription's token before it expires, one refresh per account at a time,
  writing it back; a refresh that fails is a refused credential, which holds the run once a call has gone
  through. Agents are given the placeholder and compat overrides each subscription's requests need.
