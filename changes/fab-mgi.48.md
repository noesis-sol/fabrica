- `fabrica engine update [<version>]` where no local engine answers on its socket: the CLI installs the release
  itself, with the Updater the engine uses (the signature, the archive's SHA-256, the new `fabrica --version`,
  the version's folder and the relinked `~/.local/bin/fabrica`), restarts nothing, and says the next
  `fabrica serve` runs it; as JSON, `{ from, to, launcher }`. An engine over SSH that doesn't answer is still
  an error. The fixture releases of the update's tests are in `packages/engine/test/fixture-releases.ts`,
  shared with the CLI's.
