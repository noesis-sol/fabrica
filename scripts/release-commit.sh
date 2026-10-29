#!/bin/sh
# scripts/release-commit.sh: whether HEAD is a release commit pushed alone (spec §22.5), which CI
# (.github/workflows/ci.yml) leaves unchecked: its tree is its parent's but for the changelog and the
# version, and its parent was checked when it was pushed. The release workflow
# (.github/workflows/release.yml) reads the same, to look for a release commit's check at its parent.
#
# A release commit, as `node scripts/release-notes.ts --gather X.Y.Z` makes it, has the subject
# 'Release X.Y.Z' (or a pre-release's, 'Release X.Y.Z-rc.1') and changes nothing but CHANGELOG.md, the
# change files it gathered (removed from changes/), and the "version" line of package.json files, to the
# subject's version. Pushed alone, its parent is the push's `before`.
#
# Exits 0 for one; 1 for any other commit, saying why; 2 when it can't tell. Run it at the top of a
# checkout holding HEAD's parent (actions/checkout's fetch-depth: 2).
#
#   scripts/release-commit.sh <before>
set -u
if [ $# -ne 1 ]; then
  echo "usage: $0 <before>" >&2
  exit 2
fi
before="$1"

not() {
  echo "not a release commit pushed alone: $*"
  exit 1
}

subject=$(git log -1 --format=%s HEAD) || exit 2
version=$(printf '%s\n' "$subject" |
  sed -n -E 's/^Release ([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$/\1/p')
[ -n "$version" ] || not "its subject is '$subject', not 'Release X.Y.Z'"

parent=$(git rev-parse -q --verify 'HEAD^') || not "it has no parent here"
before=$(git rev-parse -q --verify "$before^{commit}") ||
  not "the push went on '$1', which isn't a commit here"
[ "$parent" = "$before" ] ||
  not "the push went on $before, not its parent $parent, so it holds more than this commit"

# Each changed file, as its status and path, a tab between them; renames counted as a removal and an
# addition.
changes=$(git diff --no-renames --name-status "$parent" HEAD) || exit 2
manifests=
tab=$(printf '\t')
while IFS="$tab" read -r status path; do
  [ -n "$status" ] || continue
  case "$status:$path" in
  [AM]:CHANGELOG.md) ;;
  D:changes/*.md) ;;
  M:package.json | M:*/package.json) manifests="$manifests $path" ;;
  *) not "it changes $path ($status), not only the changelog and the version" ;;
  esac
done <<EOF
$changes
EOF

# Each package.json's lines changed, without the diff's own: its version's, and only that.
for manifest in $manifests; do
  changed=$(git diff -U0 "$parent" HEAD -- "$manifest" | grep -E '^[-+]' | grep -vE '^(---|\+\+\+) ')
  removed=$(printf '%s\n' "$changed" | sed -n 's/^-[[:space:]]*//p')
  added=$(printf '%s\n' "$changed" | sed -n 's/^+[[:space:]]*//p')
  other="it changes $manifest other than setting its version to $version"
  [ "$(printf '%s\n' "$changed" | grep -c .)" -eq 2 ] || not "$other"
  case "$removed" in '"version": "'*) ;; *) not "$other" ;; esac
  case "$added" in "\"version\": \"$version\"," | "\"version\": \"$version\"") ;; *) not "$other" ;; esac
done

echo "a release commit pushed alone: $version"
