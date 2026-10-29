import { Option, Schema } from 'effect'

import { SshPromptAnswer, SshPromptEvent } from '@fabrica/client'

import { bundledNode } from './local-engine'

// Main's part in ssh's prompts (spec §9.1): the connection process asks what ssh asks as it connects
// (an unknown host's key, a passphrase), main asks the page and hands the page's answers back. Main holds
// each prompt until it is answered or withdrawn, and asks the page again at each of its loads, so a
// reload loses none; a connection process that exits takes its prompts with it.

/** Where the desk's prompts go: the page, the connection process. */
export interface PromptDeskHost {
  /** Tells the page a prompt was asked or withdrawn, encoded; nothing where no page is. */
  readonly toPage: (event: typeof SshPromptEvent.Encoded) => void
  /** Hands the connection process an answer, encoded. */
  readonly toConnection: (answer: typeof SshPromptAnswer.Encoded) => void
}

const decodeEvent = Schema.decodeUnknownOption(SshPromptEvent)
const encodeEvent = Schema.encodeSync(SshPromptEvent)
const encodeAnswer = Schema.encodeSync(SshPromptAnswer)

export const makePromptDesk = (host: PromptDeskHost) => {
  const pending = new Map<number, SshPromptEvent>()
  const withdraw = (id: number): void =>
    host.toPage(encodeEvent(SshPromptEvent.cases.Withdrawn.make({ id })))

  return {
    /** What the connection process said: a prompt asked or withdrawn; anything else is dropped. */
    fromConnection: (message: unknown): void => {
      Option.map(
        decodeEvent(message),
        SshPromptEvent.match({
          Asked: asked => {
            pending.set(asked.id, asked)
            host.toPage(encodeEvent(asked))
          },
          Withdrawn: ({ id }) => {
            if (pending.delete(id)) {
              withdraw(id)
            }
          },
        }),
      )
    },
    /** The page's answer, for the connection process: dropped unless its prompt is still held. */
    answer: (answer: SshPromptAnswer): void => {
      if (pending.delete(answer.id)) {
        host.toConnection(encodeAnswer(answer))
      }
    },
    /** The page loaded: it is asked every prompt held. */
    pageLoaded: (): void => {
      for (const asked of pending.values()) {
        host.toPage(encodeEvent(asked))
      }
    },
    /** The connection process exited: its prompts are withdrawn. */
    connectionGone: (): void => {
      for (const id of pending.keys()) {
        withdraw(id)
      }
      pending.clear()
    },
  }
}

/**
 * The Node the connection process's `SSH_ASKPASS` helper runs on: in a packaged app for macOS or Linux,
 * the one the engine distribution it bundles carries (Electron's own won't run as Node: the RunAsNode
 * fuse is off); in a development build, the `node` on the PATH; none on Windows, whose ssh runs no shell
 * script, until the app ships a helper of its own: there ssh asks nothing.
 */
export const askpassNode = ({
  platform,
  packaged,
  resources,
}: {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly resources: string
}): Option.Option<string> =>
  platform === 'win32'
    ? Option.none()
    : Option.some(packaged ? bundledNode(resources) : 'node')
