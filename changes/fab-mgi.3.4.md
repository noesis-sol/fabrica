- `packages/contracts` has the agents' tools (spec §12.3, §13.6, §16), each its name, its description and the
  Effect Schemas of its arguments and its answer: the worker's `get_ticket`, `file_ticket` (a one-line title
  of at most 60 characters, `files` or `unknown`, a description not restating the title, its link),
  `ask_question` and `ask_and_wait` (2 to 4 options of one-line labels and trade-offs, one recommended, `consequential`, `maintainerOnly`, the
  ticket it blocks), `add_note`, `finish` (check_own's tree, commit and output file, and a result; `finishFor`
  narrows it to a ticket's `result_kind`), `defer` and `wait_for`; the verifier's `verdict` (`PASS`, or
  `FAIL` with a blocking finding, a finding naming the round it disagrees with); the organs' forced
  `answer` envelope; `ToolRefusal`; and `decodeArguments`, refusing keys a tool doesn't name. `TreeHash`
  joins the branded IDs.
- `json-schema.ts` turns each tool's arguments into self-contained JSON Schema (draft 2020-12, no `$ref`,
  `additionalProperties: false`), the one source the Pi extension hands to Pi (§12.2). Patterns in the
  contracts carry the `u` flag, so they reach the JSON Schema.
