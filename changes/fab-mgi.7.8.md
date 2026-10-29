- Talks (spec §15.4): the engine runs a talk as a Pi session in the project's checkout, in a mode registered
  by name (each mode a file of its own under `packages/engine/src/talks/`, added by its ticket), on the
  project's model or the one `talk.open` gives. `talk.open`, `talk.send` (a prompt, or a message into the
  running turn), `talk.close` and `talk.watchTranscript` (the model's streamed text and thinking, tool calls
  with their output, each turn's end with its tokens, batched per `stream_flush`, resumable) are served; a
  talk that can't be opened says why (`TalkNotOpened`); a mode's opening prompt shows in the transcript as the
  engine's message. A kept mode's talk (the run talk) is one per project
  and resumes its session after the engine restarts.
- `fabrica talk refine|feature|answer|run` streams the talk on the terminal, sends each line read from stdin,
  and closes the talk once stdin ends and the last message (the opening among them) is answered; a line sent
  to a talk that has ended says so; `--json` prints each transcript
  entry as JSON, `--model` overrides the project's model.
- Until the model proxy is built, the engine refuses to start a talk's agent, and no mode is registered yet.
