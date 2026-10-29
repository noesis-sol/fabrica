// The public keys a release's checksums.txt may be signed with (spec §20.4), as PKIX PEM: the engine's
// copy of scripts/install.sh's `release_keys`, which the update's tests hold it to. A new key is added
// here and there a release before an old one leaves, so the engines of both releases verify the next.
// None is here until the maintainer makes the first (scripts/sign-checksums.ts says how), and until
// then the engine installs no update.

/** The release keys, oldest first. */
export const RELEASE_KEYS: ReadonlyArray<string> = []
