import { TalkId, TranscriptItem } from '@fabrica/contracts'

import * as TalkPanel from '../../../console/talk-panel'
import * as Talks from '../../../screens/talks'
import { itemsOf } from '../../streams'

// The talks' Messages (spec §15.3, §15.4): the console's talk panel's, the Talks screen's, and the
// transcripts of the talks they hold.

export const messages = {
  /** A Message of the console's talk panel. */
  GotTalkPanelMessage: { message: TalkPanel.Message },
  /** A Message of the Talks screen's. */
  GotTalksMessage: { message: Talks.Message },
  /** The maintainer's key for the answer talk (§15.3, §18.5): it takes the talk panel. */
  RequestedAnswerTalk: {},
  /** A frame of a talk's transcript, for the panel or the Talks screen that holds the talk. */
  ReceivedTranscript: { talk: TalkId, items: itemsOf(TranscriptItem) },
  /** A talk's transcript ended: the engine no longer has the talk. */
  EndedTranscript: { talk: TalkId },
}
