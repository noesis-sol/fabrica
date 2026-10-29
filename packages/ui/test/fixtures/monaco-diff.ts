import { Effect } from 'effect'

import { showDiff } from '../../src/mounts/monaco'

// The page the Monaco diff test (test/monaco-diff.test.ts) loads: one file's two sides in the Review
// screen's diff view, mounted as the screen mounts it, and kept until the page goes.

/** Shows a two-line change in the diff view, in `window`'s #diff element. */
export const mountDiffFrom = (window: Window): void => {
  const element = window.document.getElementById('diff')
  if (element === null) {
    throw new Error('the page has no #diff element')
  }
  Effect.runFork(
    showDiff({
      element,
      path: 'src/app.ts',
      key: 'fab-1',
      sides: {
        original: 'const a = 1\nconst b = 2\n',
        modified: 'const a = 1\nconst b = 3\nconst c = 4\n',
      },
    }).pipe(Effect.andThen(Effect.never), Effect.scoped),
  )
}
