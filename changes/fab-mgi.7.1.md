- The organs' runtime: an organ asks a model through `pi-ai` with one forced `answer` tool, decoded with the
  organ's schema and retried once with the error, or through a short read-only Pi session in the checkout ending
  in the same tool, on `organs.<name>.model` (else the project's) unless it is turned off. Its calls take the
  model proxy's permits and accounting; a usage limit or a refused credential waits out its hold and goes again,
  and anything else loses that one ticket's answer, logged, while the organ's queue goes on.
