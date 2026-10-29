- The refine and feature talks (spec §15.4, §15.5): `fabrica talk refine` opens on a spec in the project's
  checkout (refused, saying why, when it isn't there) and talks it through before its breakdown;
  `fabrica talk feature` talks a feature through, opening on its text where one is given. Each files what
  it decides with `file_tree`: one root epic, the epics and tickets under it and the items each waits on,
  checked whole before anything is filed and refused with every reason at once (duplicate keys, a root
  that isn't one epic, parents that are missing or not epics, waits on items not in the tree, tickets
  naming no files, cycles among parents and waits). A refine talk's tickets carry the spec in their
  metadata. Both still wait on talk agents (the model proxy) to run in the daemon.
- A talk's tools carry the engine's side of a call: its agent hands a call over by the tool's name, and
  the engine decodes the arguments, acts as the talk's session, and answers or refuses.
