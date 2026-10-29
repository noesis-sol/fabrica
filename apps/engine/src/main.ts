#!/usr/bin/env node
import { Console, Effect } from 'effect'

import { versionLine } from './version'

Effect.runFork(Console.log(versionLine))
