- The release path (spec §22.5): `.github/workflows/release.yml`, run by hand on main with a version, builds
  the engine distribution for every engine target, signs and notarises the macOS binaries where the Apple
  secrets are set, runs each archive's `fabrica --version` on its own system, signs `checksums.txt` with the
  ed25519 release key as `checksums.txt.sig` (`scripts/sign-checksums.ts`, orchestra's scheme), attests the
  archives' provenance and publishes the GitHub Release, tagging the commit only once CI's full check has
  passed on each engine target. Without `FABRICA_RELEASE_KEY` it is a dry run, publishing nothing.
- CI leaves a release commit pushed alone to the release workflow through its own gate,
  `scripts/release-commit.sh` (its subject `Release X.Y.Z`, and only the changelog, the gathered change files
  and the version changed), never through a skip marker.
- `node scripts/release-notes.ts --gather X.Y.Z` gathers `changes/*.md` into the version's section of
  `CHANGELOG.md` and sets the version; `node scripts/release-notes.ts X.Y.Z` prints the Release's notes, the
  section cut after the last whole entry within 120,000 characters with a line linking to the rest.
- `scripts/install.sh`, attached to each release and fetched from `releases/latest/download/install.sh`,
  checks the host (macOS 13.5, glibc 2.28 and `libatomic.so.1`, the CPU against the native inventory's
  baselines), installs the arm64 build under Rosetta, verifies the signature (OpenSSL 3, or else Node) and the
  archive's SHA-256, unpacks the engine into `~/.local/share/fabrica/engine/<version>/`, runs its
  `fabrica --version` there, reading stdout only, and links `~/.local/bin/fabrica`. It holds no release key
  yet, and installs nothing until the maintainer adds the first.
