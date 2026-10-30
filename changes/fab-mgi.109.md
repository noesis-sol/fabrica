- The console names a project with its engine: the same repository added on this machine and on a known engine
  has one project ID on both, and is now two projects. The scope, the sidebar's rows and selection, the
  palette's project entries and a notification's target each carry the engine with the project
  (`packages/ui/src/app/engine-project.ts`); every request and stream for a project goes to the engine it
  names, and each lookup by project (its row, chip, name and run going, History's events, the attention cards'
  chips) keys on both. Selecting the known engine's row scopes to its project, not this machine's.
