- The run talk (spec §15.4, H44): `fabrica talk run`, and the console's conversation panel once its agents
  run, one per project with its Pi session kept across restarts. It reads the run's view and events, tickets
  (`show`, `why`, `ready`), a worker's recent transcript, the log and what waits on the maintainer, and acts
  through the engine's commands: message a worker; start, drain, undrain or stop a run; hold a ticket until
  another merges; file, update, defer, label, close or cancel tickets; answer a question in the maintainer's
  words; answer a permission request; open the answer talk. It has no other tool, not even Pi's readers.
- A stop, a close, a cancel or an allowed permission takes the maintainer's word: the first call is refused
  with the one line to ask (`confirm_first`), naming exactly what it would do, a permission request by its ID
  and its call; the same call goes through only in the turn the maintainer's next message opens.
- Every action is a record of the event stream, `talk_action` with actor `run_talk` and the talk it opened,
  shown in History while a run goes; with no run going it goes on the project's stream under its last run.
