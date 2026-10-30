import { Schema } from 'effect'

import { SshPromptAnswer } from '@fabrica/client'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'

// The page's answers to what ssh asked (spec §9.1), handed to the prompt desk of ../ssh-prompts for
// the connection process.

/** What main does with the page's answers to ssh. */
export interface SshAnswersActions {
  /** The page's answer to what ssh asked (spec §9.1), for the connection process. */
  readonly answerSshPrompt: (answer: SshPromptAnswer) => void
}

const decodeSshAnswer = Schema.decodeUnknownOption(
  Schema.Tuple([SshPromptAnswer]),
)

/** Registers the ssh answers' channel on `ipc`, acted on by `actions`. */
export const sshAnswersChannels = (
  ipc: IpcRegistrar,
  actions: SshAnswersActions,
): void =>
  ipc.onSend(channels.answerSshPrompt, decodeSshAnswer, ([answer]) =>
    actions.answerSshPrompt(answer),
  )

/** Registers the ssh answers on `ipc`, for the prompt desk. */
export const registerSshAnswers = (
  ipc: IpcRegistrar,
  { promptDesk }: MainContext,
): void => sshAnswersChannels(ipc, { answerSshPrompt: promptDesk.answer })
