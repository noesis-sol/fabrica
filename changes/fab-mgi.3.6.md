- `packages/engine/src/files` is the one way the engine reads and writes its files (spec §20.2, §13.12,
  H62, H84): a file written whole goes through a synced temporary file of its own name, a rename and a
  synced folder; files are named by a trusted root and a path inside it, every folder on the way a real
  folder, and opened without following a link, non-blocking, only when regular (a named pipe is
  refused); a truncating open of a hard-linked file creates it afresh, and an append copies it to a file
  of its own, never writing through to the linked file; the line stream repairs a torn last line and
  loses only the record a short write cut.
