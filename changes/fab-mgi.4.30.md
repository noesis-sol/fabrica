- A ticket closed, deferred or claimed by another between the ready read and its claim is dropped from the run
  with `NOT_CLAIMED`, the work graph left as it is: it no longer ends the run `TRACKER_FAILED`, re-defers the
  ticket indefinitely or frees another's claim. A dispatch gives back only a claim it made, and a change the
  work graph refuses because a ticket moved under the run says `TICKET_MOVED` rather than stopping it.
