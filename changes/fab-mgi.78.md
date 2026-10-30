- The desktop app keeps the engines it knows (spec §9.1): an engine Add engine installed or updated on a host
  over SSH, or found up to date there, joins them under the name the user gave it in the form (its host's where
  none is given; never `local`, nor another engine's) and is connected to at once, kept in the app's state
  (`state.json` in its data folder) once its first hello gives its ID and protocol version; the app reads them
  as it starts (`fabrica:known-engines`, `fabrica:keep-engine`).
- Each known engine on another host is reached through its own connection: the page asks main for a port to it
  at each attempt (`fabrica:connect-engine`), which main relays to the engine's SSH or WSL2 bridge through the
  connection process; each engine's connection runs on its own, so one failing and tried again after a
  pause, one added, or one the user tries again or updates leaves the others' connections up. Its
  projects join the sidebar's under its name, and the Engines screen has a card for it with its connection's
  state, Try again where ssh refused its host, and, where it refused the app's version, its update over SSH the
  way this machine's is offered, the connection tried again once it is updated.
- A remote engine's projects are listed only: selecting one still sends its requests and streams through the
  local engine's connection, and History and the notifications follow the local engine's runs alone, until
  each project's requests go through its own engine's connection.
