- The verifier's rounds are kept with the ticket, engine-local in the work graph: a ticket dispatched again
  (its question answered, carried over, undeferred) goes on counting toward `verifier.rounds`, and its
  verifier weighs the earlier rounds' findings, rather than starting again at round 1.
