import { Data } from 'effect'

// What can go wrong making a test's surroundings.

/** A tool a toolbox names isn't on the PATH it was looked for on. */
export class ToolNotFound extends Data.TaggedError('ToolNotFound')<{
  readonly tool: string
  readonly path: string
}> {
  override get message() {
    return `${this.tool} isn't on the PATH ${this.path}`
  }
}

/** The system refused making a file or folder the kit needed. */
export class KitFailed extends Data.TaggedError('KitFailed')<{
  readonly operation: string
  readonly path: string
  readonly cause: unknown
}> {
  override get message() {
    return `couldn't ${this.operation} at ${this.path}: ${String(this.cause)}`
  }
}

/** A command a test ran exited with an error. */
export class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly stderr: string
}> {
  override get message() {
    return `${[this.command, ...this.args].join(' ')} failed in ${this.cwd}: ${this.stderr.trim()}`
  }
}
