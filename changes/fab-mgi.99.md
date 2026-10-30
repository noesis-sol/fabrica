- The client reads the engine's NDJSON frames in one pass: its parser is given a transport's reads only once
  one ends a frame (or they pass the 16 MiB frame limit), where Effect's parser searched all it held at every
  read, so a frame that came in many reads (macOS reads a local socket 8 KiB at a time) cost time in its size
  squared, 2 s for 16 MiB.
