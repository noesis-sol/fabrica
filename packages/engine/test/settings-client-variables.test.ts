import { describe, expect, it } from '@effect/vitest'

import { settingVariables, variableOf } from '../src/settings'

// The FABRICA_ variables a client starting a run sends of its environment (spec §13.13): those of
// settings it sets, by name, and no other variable.

describe('the FABRICA_ variables of settings', () => {
  it('names each setting by its path', () => {
    expect(variableOf('concurrent')).toBe('FABRICA_CONCURRENT')
    expect(variableOf('verifier.rounds')).toBe('FABRICA_VERIFIER_ROUNDS')
  })

  it('takes the settings’ variables set, and nothing else of the environment', () => {
    expect(
      settingVariables({
        FABRICA_CONCURRENT: '1',
        FABRICA_VERIFIER_ROUNDS: '2',
        FABRICA_AUTO_ANSWER: undefined,
        FABRICA_CORES: '4',
        HOME: '/home/someone',
      }),
    ).toStrictEqual({ FABRICA_CONCURRENT: '1', FABRICA_VERIFIER_ROUNDS: '2' })
  })
})
