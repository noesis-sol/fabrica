- The release installs its dependencies before the scripts that import them run: the `check` job installs
  first, before checking the notes (`scripts/release-notes.ts`) and the release key
  (`scripts/sign-checksums.ts`), and the `engine release` job installs before signing the engine's
  `checksums.txt`, where Node couldn't resolve `effect` without them.
