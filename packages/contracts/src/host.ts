import { Context, type Effect, Schema } from 'effect'

// The facts about its host the engine reads (spec §7.3, §18.3, §24): its cores, memory, load and home
// folder. They are read only through the `Host` service, so a test injects them (H55): a test that
// read the machine's cores passed on tutti's 10-core Mac and failed on CI's 2-core runners.

/** The host as read at one moment. */
export class HostFacts extends Schema.Class<HostFacts>('HostFacts')({
  /** The cores the engine may use: `os.availableParallelism()`. */
  cores: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The host's memory, in bytes. */
  memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The 1-minute load average; 0 where the OS keeps none (Windows). */
  load: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The home folder of the user the engine runs as. */
  home: Schema.String.check(Schema.isMinLength(1)),
}) {}

/** Reads the facts about the host. */
export class Host extends Context.Service<
  Host,
  {
    /** The facts as of now: load and memory change between reads. */
    readonly facts: Effect.Effect<HostFacts>
  }
>()('Host') {}
