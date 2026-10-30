import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  OutputStep,
  outputStep,
  terminalColoursOf,
} from '../src/mounts/terminal'
import { Theme } from '../src/theme/theme'
import themesCss from '../src/theme/themes.css?raw'

// A tool call's output in xterm.js (spec §18.1, §18.4): the terminal is made once and writes what each
// rewrite of the output added, starting over where the output doesn't go on from what it wrote; its
// colours come from themes.css's tokens. Story tests can't run a Mount, so its rules are checked here.

describe("a tool call's output in the terminal", () => {
  it('writes what each rewrite added', () => {
    expect(outputStep('', 'ok 1\n')).toEqual(
      OutputStep.Append({ text: 'ok 1\n' }),
    )
    expect(outputStep('ok 1\n', 'ok 1\nok 2\n')).toEqual(
      OutputStep.Append({ text: 'ok 2\n' }),
    )
    expect(outputStep('ok 1\n', 'ok 1\n')).toEqual(
      OutputStep.Append({ text: '' }),
    )
  })

  it('starts over where the output no longer goes on from what it wrote', () => {
    expect(outputStep('ok 1\nok 2\n', 'fresh\n')).toEqual(
      OutputStep.Restart({ text: 'fresh\n' }),
    )
  })

  it("takes every theme's colours from its tokens, as hex", () => {
    for (const theme of Theme.literals) {
      const colours = Option.getOrThrow(terminalColoursOf(themesCss, theme))
      for (const value of Object.values(colours)) {
        expect(value).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u)
      }
    }
  })

  it('has no colours where the tokens are missing', () => {
    expect(terminalColoursOf('', 'classic')).toEqual(Option.none())
  })
})
