- The packaged app's smoke test now opens a fixture repository through the console (Add project) and runs one
  ticket to its merge with a stub model: the real Pi, through the engine's model proxy, on the port of a local
  model's route. On a signed release's call, the Windows app adds and reaches its engine in WSL2 through the
  console, where the runner's WSL2 is ready.
- A local model works: `model: ollama/…` or `lmstudio/…` failed with Pi's `Unknown provider`, as `models.json`
  gave the provider no API and no model. It now names the agent's model with the API its route speaks.
- The app builds again: `update/relaunch.ts` imported the TLS listener's settings from the engine's serving,
  which brought the whole engine and DuckDB into Electron's main bundle, and electron-vite failed on DuckDB's
  native packages. They are a module of their own, `engine/listen-settings.ts`.
