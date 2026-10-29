- The macOS app tells its notifications while its window is closed: closing the window hides it until the
  app quits, its page kept deciding what to tell (questions, permission requests, a run's end, a hold), its
  timers unthrottled; a hidden or minimized page, which gets no animation frames, takes in what arrives
  after 100 ms at most. A click on a notification, the Dock or a second start shows the window again.
