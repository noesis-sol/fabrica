- The console's In progress column (`packages/ui/src/console/in-progress.ts`): each ticket working, verifying,
  waiting to merge, merging or handed back as the handoff's card, its ID and title; the phase bar, a segment
  each for working, verifying, waiting to merge and merging, those passed filled, the current one in its
  project's colour (its sidebar chip's), a hand-back striped on merging; and the step with its elapsed time:
  the engine's step for the ticket (its setup, its merge check), else its worker's latest action ("Running
  scripts/check-own.sh"), else its place in the queue ("2nd to merge", "in the train") or its phase in words.
  No percentage. Every card keeps one height, and clicking one opens its worker view.
