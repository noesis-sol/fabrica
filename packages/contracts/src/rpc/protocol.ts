import {
  type JsonSchema,
  Schema,
  type SchemaAST,
  SchemaRepresentation,
} from 'effect'
import { type Rpc, type RpcGroup, RpcSchema } from 'effect/rpc'

import { AttentionRpcs } from './attention'
import { BacklogRpcs } from './backlog'
import { EngineRpcs } from './engine'
import { InsightsRpcs } from './insights'
import { ProjectRpcs } from './projects'
import { ReviewRpcs } from './review'
import { RunRpcs } from './runs'
import { SecretRpcs } from './secrets'
import { TalkRpcs } from './talks'
import { TokenRpcs } from './tokens'
import { type ProtocolVersion, protocolVersion } from './version'
import { WorkerRpcs } from './workers'

// The whole client–engine protocol (spec §8.1): every group, merged into the one group the engine
// serves and its clients call, and the protocol as JSON Schema for clients in other languages. The
// JSON Schema describes each message as it crosses: Effect RPC's JSON serialisation (`toCodecJson`).

/** The groups' names, in §8.1's order. */
export const ProtocolGroupName = Schema.Literals([
  'engine',
  'tokens',
  'secrets',
  'projects',
  'backlog',
  'runs',
  'workers',
  'attention',
  'talks',
  'review',
  'insights',
])
export type ProtocolGroupName = typeof ProtocolGroupName.Type

/** The groups of §8.1. */
export const protocolGroups = {
  engine: EngineRpcs,
  tokens: TokenRpcs,
  secrets: SecretRpcs,
  projects: ProjectRpcs,
  backlog: BacklogRpcs,
  runs: RunRpcs,
  workers: WorkerRpcs,
  attention: AttentionRpcs,
  talks: TalkRpcs,
  review: ReviewRpcs,
  insights: InsightsRpcs,
} satisfies { readonly [Name in ProtocolGroupName]: RpcGroup.Any }

/** Every request and stream of the protocol. */
export const FabricaRpcs = EngineRpcs.merge(
  TokenRpcs,
  SecretRpcs,
  ProjectRpcs,
  BacklogRpcs,
  RunRpcs,
  WorkerRpcs,
  AttentionRpcs,
  TalkRpcs,
  ReviewRpcs,
  InsightsRpcs,
)
export type FabricaRpcs = typeof FabricaRpcs

/** One request or stream, as JSON Schema: a stream's `success` is each item it sends, its `error` what ends it. */
export interface RpcJsonSchema {
  readonly tag: string
  readonly group: ProtocolGroupName
  readonly stream: boolean
  readonly payload: JsonSchema.JsonSchema
  readonly success: JsonSchema.JsonSchema
  readonly error: JsonSchema.JsonSchema
}

/** The protocol as JSON Schema (draft 2020-12), its named schemas shared in `definitions`. */
export interface ProtocolJsonSchema {
  readonly dialect: 'draft-2020-12'
  readonly protocol: ProtocolVersion
  readonly rpcs: ReadonlyArray<RpcJsonSchema>
  readonly definitions: JsonSchema.Definitions
}

/** A request's three schemas, a stream's item and error in place of its success and error. */
interface Shapes {
  readonly tag: string
  readonly group: ProtocolGroupName
  readonly stream: boolean
  readonly schemas: readonly [Schema.Top, Schema.Top, Schema.Top]
}

const shapesOf = (group: ProtocolGroupName, rpc: Rpc.AnyWithProps): Shapes => {
  const success = rpc.successSchema
  return RpcSchema.isStreamSchema(success)
    ? {
        tag: rpc._tag,
        group,
        stream: true,
        schemas: [rpc.payloadSchema, success.success, success.error],
      }
    : {
        tag: rpc._tag,
        group,
        stream: false,
        schemas: [rpc.payloadSchema, success, rpc.errorSchema],
      }
}

const rpcsOf = (group: {
  readonly requests: ReadonlyMap<string, Rpc.AnyWithProps>
}): ReadonlyArray<Rpc.AnyWithProps> => [...group.requests.values()]

const jsonAst = (schema: Schema.Top): SchemaAST.AST =>
  Schema.toCodecJson(schema).ast

/** The protocol as JSON Schema: every group's requests and streams, in order. */
export const protocolJsonSchema = (): ProtocolJsonSchema => {
  const shapes = ProtocolGroupName.literals.flatMap(name =>
    rpcsOf(protocolGroups[name]).map(rpc => shapesOf(name, rpc)),
  )
  const [first, ...rest] = shapes.flatMap(({ schemas }) => schemas.map(jsonAst))
  if (first === undefined) {
    return {
      dialect: 'draft-2020-12',
      protocol: protocolVersion,
      rpcs: [],
      definitions: {},
    }
  }
  const document = SchemaRepresentation.toJsonSchemaMultiDocument(
    SchemaRepresentation.toRepresentations([first, ...rest]),
  )
  return {
    dialect: document.dialect,
    protocol: protocolVersion,
    rpcs: shapes.map(({ tag, group, stream }, index) => ({
      tag,
      group,
      stream,
      payload: document.schemas[index * 3] ?? {},
      success: document.schemas[index * 3 + 1] ?? {},
      error: document.schemas[index * 3 + 2] ?? {},
    })),
    definitions: document.definitions,
  }
}
