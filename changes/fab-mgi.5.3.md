- The desktop app's connection process (`apps/desktop/src/connection`): an Electron utilityProcess, built
  beside main as `out/main/connection.js`, that relays each page's engine port to the local engine's socket,
  a new engine connection for each connection the page opens. Main starts it, brokers a port pair at each
  load of a page (`src/main/ports.ts`) and stays out of the data path; a connection process that exits is
  started again. `@fabrica/client` has the MessagePort transport (`portSocket` for the page, `portServer`
  for the relay): NDJSON frames as they are, with numbered signals for each connection's open and close, so
  a dropped engine connection reaches the page's client, which reconnects and resumes its streams.
