- `packages/pi-extension` is the first-party Pi extension (spec §12.2, §12.3, §12.4), built against Pi 1.4.0's
  extension API: Pi loads its default export with `--extension`. It registers the worker's tools
  (`pi.registerTool`), each one's arguments' JSON Schema from `@fabrica/contracts` wrapped with `Type.Unsafe`,
  decodes each call's arguments again with the tool's Effect Schema, and forwards it to the engine over the
  control socket and token the environment names (`FABRICA_CONTROL_SOCKET`, `FABRICA_CONTROL_TOKEN`); an
  invalid payload, or the engine's refusal said in words, fails the call so the agent tries again, and an
  outcome tool's answer asks Pi to stop. `before_agent_start` puts the standing rules (version 1, orchestra's
  worker prompt adapted) in the system prompt's `fabrica_rules` section, the project's `.fabrica/worker-rules.md`
  appended. `agent_before_settle` nudges a turn with no outcome once, and reports a second settle without one
  as unfinished (`report_unfinished`); `agent_settled` records how the turn settled in the session
  (`fabrica-settled`). `project_trust` refuses the project's own Pi resources until `FABRICA_PROJECT_TRUSTED` is
  `1`, a new variable in `@fabrica/contracts`. Copilot's OAuth is registered again at the proxy's base URL from
  the agent's `models.json` (fab-mgi.12). `src/gate/index.ts` is the gate's place in `tool_call`: the
  extension's own tools are always allowed, and every other call is, until the gate ticket fills it.
