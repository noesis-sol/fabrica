- A talk's streamed text is drawn at most every 33 ms, in the console's talk panel and on the Talks screen,
  as the Worker view's transcript is (§18.5, H79): the frames that arrive during a draw's wait are drawn
  together at its end, rather than every animation frame. The buffer is one module, `app/draw.ts`, that the
  Worker view and the talks share.
