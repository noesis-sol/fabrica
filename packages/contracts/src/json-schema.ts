import { type JsonSchema, Schema } from 'effect'

import { type AnyTool, VerdictTool, WorkerTools } from './tools'

// Tool schemas have one source, the Effect Schemas in `tools.ts` (spec §12.2): this turns a tool's
// arguments into the JSON Schema a model is shown, which the Pi extension wraps as a TypeBox schema
// (`Type.Unsafe`). Every schema is written out in place, with no `$ref`, so the document stands alone
// whatever a provider makes of references; keys the arguments don't name are refused
// (`additionalProperties: false`), as `decodeArguments` refuses them. The JSON Schema is a first
// check only: the Effect Schema decodes the arguments again and is the final word.

/** A tool as a model is shown it: its name, its description and its arguments' JSON Schema. */
export interface ToolJsonSchema {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema.JsonSchema
}

/**
 * The JSON Schema (draft 2020-12) of a tool's arguments, with no references. A tool taking none
 * (`check_own`) is an object with no keys, where Effect would write any value but null.
 */
export const parametersJsonSchema = (tool: AnyTool): JsonSchema.JsonSchema =>
  Object.keys(tool.parameters.fields).length === 0
    ? { type: 'object', properties: {}, additionalProperties: false }
    : Schema.toJsonSchemaDocument(tool.parameters, {
        referencePolicy: () => undefined,
        onExcessProperty: 'error',
      }).schema

/** A tool with its arguments' JSON Schema. */
export const toolJsonSchema = (tool: AnyTool): ToolJsonSchema => ({
  name: tool.name,
  description: tool.description,
  parameters: parametersJsonSchema(tool),
})

/** The worker's tools, as the extension registers them with Pi. */
export const workerToolJsonSchemas = (): ReadonlyArray<ToolJsonSchema> =>
  WorkerTools.map(toolJsonSchema)

/** The verifier's `verdict` tool. */
export const verdictToolJsonSchema = (): ToolJsonSchema =>
  toolJsonSchema(VerdictTool)
