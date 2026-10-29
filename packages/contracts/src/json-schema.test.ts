import { Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  parametersJsonSchema,
  verdictToolJsonSchema,
  workerToolJsonSchemas,
} from './json-schema'
import { ResultKind } from './ticket'
import { WorkerTools, answerTool, finishFor } from './tools'

/** `finish` narrowed to a ticket's `result_kind`, named after it. */
const finishOf = (kind: ResultKind) => {
  const tool = finishFor(kind)
  return {
    name: `${tool.name} (${kind})`,
    description: tool.description,
    parameters: parametersJsonSchema(tool),
  }
}

const tools = [
  ...workerToolJsonSchemas(),
  verdictToolJsonSchema(),
  ...ResultKind.literals.map(finishOf),
]

/** Every value under `schema`, at any depth. */
const everything = (schema: unknown): ReadonlyArray<unknown> =>
  typeof schema === 'object' && schema !== null
    ? [schema, ...Object.values(schema).flatMap(everything)]
    : [schema]

describe('the tools’ JSON Schema', () => {
  it.each(tools)(
    '$name matches its snapshot',
    ({ parameters, description }) => {
      expect({ description, parameters }).toMatchSnapshot()
    },
  )

  it.each(tools)(
    '$name is an object refusing other keys, with no references',
    ({ parameters }) => {
      expect(parameters['type']).toBe('object')
      expect(parameters['additionalProperties']).toBe(false)
      expect(
        everything(parameters).some(
          value =>
            typeof value === 'object' && value !== null && '$ref' in value,
        ),
      ).toBe(false)
    },
  )

  it('has one for every worker tool, in order', () => {
    expect(workerToolJsonSchemas().map(({ name }) => name)).toEqual(
      WorkerTools.map(({ name }) => name),
    )
  })

  it('carries file_ticket’s title limit and the question’s option count', () => {
    const [, fileTicket, askQuestion] = workerToolJsonSchemas()
    expect(JSON.stringify(fileTicket?.parameters)).toContain('"maxLength":60')
    expect(JSON.stringify(askQuestion?.parameters)).toContain('"minItems":2')
    expect(JSON.stringify(askQuestion?.parameters)).toContain('"maxItems":4')
  })

  it('wraps an organ’s answer in an object', () => {
    const parameters = parametersJsonSchema(
      answerTool({
        answer: Schema.Array(Schema.String),
        description: 'The files it will likely change.',
      }),
    )
    expect(parameters).toEqual({
      type: 'object',
      properties: { answer: { type: 'array', items: { type: 'string' } } },
      required: ['answer'],
      additionalProperties: false,
    })
  })
})
