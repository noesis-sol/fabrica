- A known engine's project is asked of its own engine: every request and stream for a project (its run view,
  attention, backlog, run talk and talks, worker views, Review, Insights, its settings, its run controls, its
  set-up and trust) goes through the connection of the engine whose sidebar row holds it, each known engine's
  session held by its name while it is connected (`packages/ui/src/app/engine-route.ts`). The stats row's load
  is the scoped project's engine's; History under All projects and the notifications follow every engine's
  runs, the notifications reading each engine's attention requests apart.
