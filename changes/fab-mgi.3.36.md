- CI (`.github/workflows/ci.yml`): on every push and pull request, the full check on macOS x64, macOS arm64,
  Linux x64 and Linux arm64, and the fast check on Linux x64 held to 2 cores; test files on every core of the
  runner. Every download is checked: the actions by commit, mise by its signed checksums, Node and pnpm against
  the new `mise.lock`, npm packages against the lockfile; the pnpm store is cached. actionlint and shellcheck
  join the requires list, for linting the workflows.
