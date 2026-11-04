- A worker's turn that a hold outlasts is no longer read as unfinished. A hold raised on another caller's refusal
  keeps its model call at the proxy's permit past Pi's timeout and retries, and its turn ends on the error with no
  refusal of its own: its supervision now waits for the lift and resumes its session, and a hand-back's turn ends
  there, for the merge queue to take its work where git shows it done. A worker that settles twice with no outcome,
  or whose call failed with its provider not held, is set aside as before.
