- A worker's transcript (`worker.watchTranscript`) ends as the worker's part in the run ends (its ticket
  merged, asked, set aside or stopped) and as the run ends, so a client knows the worker has finished; a
  later dispatch of the ticket takes the same transcript up again.
- Transcripts carry `tool_input`, read from Pi's streamed tool calls as its RPC mode sends them (a
  `toolcall_start` naming the call and its tool, then `toolcall_delta`s naming only the message's part):
  more of a call's input as the model writes it, never drawn whole until its `tool_call` (§18.5).
