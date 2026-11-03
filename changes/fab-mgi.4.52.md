- The engine update's downloads, and the app's of a release it installs, are time-limited as orchestra's are:
  30 seconds for checksums.txt and for its signature, 5 minutes for the archive, from the request to the
  body's end. A stalled download fails the update with a time-out rather than holding it, and every later
  one, until the engine restarts; each chunk is written whole.
