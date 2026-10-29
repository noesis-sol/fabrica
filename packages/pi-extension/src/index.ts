import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { readEnvironment } from './environment'
import { makeExtension } from './extension'
import { fromExtensionApi } from './pi'

// The package's entry, which Pi loads with `--extension` (spec §12.1): the first-party extension, its
// facts read from the agent's environment.

export default function fabrica(pi: ExtensionAPI): Promise<void> {
  return makeExtension(readEnvironment(process.env, process.cwd()))(
    fromExtensionApi(pi),
  )
}

export {
  decide,
  GateDecision,
  GateEngine,
  type GateCall,
  type GateFacts,
} from './gate'
export {
  ProjectRulesPath,
  StandingRulesTemplate,
  StandingRulesVersion,
} from './rules'
