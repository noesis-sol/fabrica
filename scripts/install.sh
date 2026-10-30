#!/bin/sh
# scripts/install.sh: installs the Fabrica engine from its latest GitHub Release, or the one
# FABRICA_VERSION names (spec §9.2, §22.5):
#
#   curl -fsSL https://github.com/noesis-sol/fabrica/releases/latest/download/install.sh | sh
#
# Each release carries this script among its assets (.github/workflows/release.yml), so the script that
# installs a release is the one it was made with, not main's.
#
# It checks the host first: macOS 13.5 or later; on Linux glibc 2.28 or later and libatomic.so.1, which
# the engine's Node needs; and the CPU against the native inventory's baselines (§22.4), refusing what
# would crash with "illegal instruction". In a shell under Rosetta on Apple Silicon it installs the
# darwin arm64 build, which runs natively. Then it downloads the release's archive for this host,
# checksums.txt and its signature, checksums.txt.sig; verifies the signature with the release keys below,
# with OpenSSL 3 or else a Node on the PATH (macOS's own openssl, LibreSSL, can't verify ed25519: with
# neither it says so and goes on), and the archive's SHA-256 against checksums.txt; unpacks it into
# ~/.local/share/fabrica/engine/<version>/; runs its fabrica --version there, reading stdout only, never
# in /tmp, which hardened hosts mount noexec; and links ~/.local/bin/fabrica to it, saying how to put
# that folder on the PATH. It never calls sudo.
#
#   FABRICA_VERSION      the release to install, such as v0.1.0; the latest when unset
#   FABRICA_INSTALL_DIR  a folder of the PATH's, made where it doesn't exist, to link fabrica into as
#                        well, its link naming ~/.local/bin/fabrica; never /usr/local/bin, which Homebrew
#                        owns on many Macs
#
# ~/.local/bin/fabrica is made whatever FABRICA_INSTALL_DIR names, since it is the link §7.1 and §9.2
# name: fabrica engine update switches it to the version it installs, and the login service runs it.
#
# For the tests only (scripts/install.test.ts): FABRICA_DOWNLOAD_URL replaces the releases' address,
# https://github.com/noesis-sol/fabrica/releases. It may be a file:// URL of a folder laid out as GitHub
# serves a release's files, download/<tag>/<name>, with a file `latest` holding the latest tag. In that
# mode alone FABRICA_TEST_RELEASE_KEY (a PEM public key) replaces the release keys,
# FABRICA_TEST_CPUINFO replaces /proc/cpuinfo, where Linux's CPU flags are read, FABRICA_TEST_LIB_DIRS
# the folders libatomic.so.1 is looked for in, and FABRICA_TEST_OPENSSL (paths, separated by spaces)
# the openssl commands tried; no ldconfig is asked. uname, sysctl, sw_vers, getconf and ldd are found on
# the PATH (sysctl and sw_vers then in /usr/sbin and /usr/bin), so a test puts fakes first.
#
# Everything runs from main, at the end, so that a download cut short runs nothing. POSIX sh: it runs
# under sh, dash and bash.
set -eu

# The public keys a release's checksums.txt may be signed with (PKIX PEM, as
# `openssl pkey -in release-key.pem -pubout` prints the release key's; scripts/sign-checksums.ts says
# how to make it). A new key is added here a release before an old one leaves. None is here until the
# maintainer makes the first, and until then the script installs nothing.
release_keys=''

# The native inventory's CPU baselines (spec §22.4): what each component with native code in the engine
# distribution needs of an x64 CPU beyond x86-64 itself, as component:flag, the flag as Linux's
# /proc/cpuinfo names it (macOS's sysctl as hw.optional.<flag>). Node 26 needs SSE2, which V8 makes
# mandatory. On arm64 each needs only armv8-a, which every arm64 CPU has.
x64_baselines='Node:sse2'

releases=https://github.com/noesis-sol/fabrica/releases
script_url=https://github.com/noesis-sol/fabrica/releases/latest/download/install.sh
cpuinfo=/proc/cpuinfo
openssl_candidates='openssl /opt/homebrew/bin/openssl /usr/local/opt/openssl@3/bin/openssl'
ldconfig_candidates='ldconfig /sbin/ldconfig /usr/sbin/ldconfig'
lib_dirs=

say() { printf '%s\n' "$*"; }
fail() {
  printf 'fabrica install: %s\n' "$*" >&2
  exit 1
}

# platform sets os and arch, as the engine's targets name them (darwin or linux, x64 or arm64), from
# uname, or stops on a host without an engine distribution. It also sets machine, uname -m's.
platform() {
  kernel="$(uname -s)"
  machine="$(uname -m)"
  case "$kernel" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) os= ;;
  esac
  case "$machine" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch= ;;
  esac
  if [ -z "$os" ] || [ -z "$arch" ]; then
    fail "there is no engine distribution for $kernel $machine: releases have macOS and Linux, arm64 and
x64. On Windows, install the engine in WSL2."
  fi
}

# found prints the first of the commands $1 (a list, separated by spaces) that is there, or nothing.
found() {
  for candidate in $1; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
}

# sysctl_value prints macOS's sysctl -n $1, or nothing where it has no such name (sysctl.proc_translated
# on an Intel Mac) or no sysctl is found.
sysctl_value() {
  sysctl="$(found 'sysctl /usr/sbin/sysctl')"
  [ -z "$sysctl" ] || "$sysctl" -n "$1" 2>/dev/null </dev/null || true
}

# at_least says whether the version $1 (such as 13.5.2) is $2 (such as 13.5) or later.
at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    n = split(have, h, "."); m = split(want, w, ".")
    for (i = 1; i <= (n > m ? n : m); i++) {
      if (h[i] + 0 > w[i] + 0) exit 0
      if (h[i] + 0 < w[i] + 0) exit 1
    }
    exit 0
  }'
}

# rosetta sets arch to arm64 in a shell under Rosetta on Apple Silicon, saying so.
rosetta() {
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl_value sysctl.proc_translated)" = 1 ]; then
    arch=arm64
    say "This shell runs under Rosetta on Apple Silicon: installing the darwin arm64 build, which runs natively."
  fi
}

# macos checks macOS's version: the engine's Node needs 13.5 or later.
macos() {
  sw_vers="$(found 'sw_vers /usr/bin/sw_vers')"
  release=
  [ -z "$sw_vers" ] || release="$("$sw_vers" -productVersion 2>/dev/null </dev/null || true)"
  case "$release" in
  [0-9]*) at_least "$release" 13.5 || fail "the engine needs macOS 13.5 or later, and this is macOS $release. Nothing was installed." ;;
  *) say "Couldn't tell the macOS version, which must be 13.5 or later; installing all the same." ;;
  esac
}

# glibc prints the C library's glibc version, musl where it is musl, or nothing where it can't tell.
glibc() {
  if command -v getconf >/dev/null 2>&1; then
    said="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    case "$said" in
    "glibc "[0-9]*)
      printf '%s\n' "${said#glibc }"
      return
      ;;
    esac
  fi
  if command -v ldd >/dev/null 2>&1; then
    # musl's ldd prints "musl libc (<machine>)" and exits 1; glibc's first line ends in its version.
    said="$(ldd --version 2>&1 </dev/null || true)"
    case "$said" in
    *musl*) say musl ;;
    *"GNU libc"* | *GLIBC* | *glibc*) printf '%s\n' "$said" | awk 'NR == 1 { print $NF }' ;;
    esac
  fi
}

# libatomic says whether libatomic.so.1 is there: in ldconfig's cache, or in one of the library folders.
libatomic() {
  ldconfig="$(found "$ldconfig_candidates")"
  if [ -n "$ldconfig" ] && "$ldconfig" -p 2>/dev/null </dev/null | grep -q 'libatomic\.so\.1 '; then
    return 0
  fi
  for folder in $lib_dirs; do
    [ ! -e "$folder/libatomic.so.1" ] || return 0
  done
  return 1
}

# linux checks the C library: the engine's Node is built against glibc 2.28 or later, and links
# libatomic.so.1, which slim images leave out.
linux() {
  libc_version="$(glibc)"
  case "$libc_version" in
  musl) fail "the engine needs glibc 2.28 or later, and this system's C library is musl (Alpine): install it
on a glibc distribution, or in a container of one. Nothing was installed." ;;
  [0-9]*) at_least "$libc_version" 2.28 || fail "the engine needs glibc 2.28 or later, and this system has glibc $libc_version. Nothing was installed." ;;
  *) say "Couldn't tell the glibc version, which must be 2.28 or later; installing all the same." ;;
  esac
  libatomic || fail "the engine's Node needs libatomic.so.1, which isn't installed: install it (apt-get install
libatomic1, dnf install libatomic, or zypper install libatomic1) and run this again. Nothing was installed."
}

# has_flag prints 1 where the CPU has the flag $1, 0 where it hasn't, nothing where it can't tell.
has_flag() {
  if [ "$os" = darwin ]; then
    sysctl_value "hw.optional.$1"
  else
    # Each CPU's line of flags, "flags : fpu vme … sse2 …": 1 where one names the flag, 0 where none
    # does, nothing where there is no such line or no file to read.
    awk -v flag="$1" '/^flags[ \t]*:/ { flags = 1; for (i = 1; i <= NF; i++) if ($i == flag) found = 1 }
      END { if (found) print 1; else if (flags) print 0 }' "$cpuinfo" 2>/dev/null </dev/null || true
  fi
}

# cpu stops on an x64 CPU without a flag a component needs (x64_baselines), naming the component, so that
# nothing crashes later with "illegal instruction" without a word why. Where the CPU's flags can't be
# read, it says so and goes on.
cpu() {
  [ "$arch" = x64 ] || return 0
  for baseline in $x64_baselines; do
    component="${baseline%%:*}"
    flag="${baseline#*:}"
    case "$(has_flag "$flag")" in
    1) ;;
    0) fail "$component, in the engine, needs an x64 CPU with $(printf '%s' "$flag" | tr '[:lower:]' '[:upper:]'), and this one has none. Nothing was installed." ;;
    *) say "Couldn't tell whether this CPU has $flag, which $component needs; installing all the same." ;;
    esac
  done
}

# fetch downloads the address $1 into the file $2, with curl or else wget.
fetch() {
  if [ "$downloader" = curl ]; then
    curl -fsSL -o "$2" "$1" </dev/null
  else
    wget -q -O "$2" "$1" </dev/null
  fi || fail "cannot download $1"
}

# latest prints the latest release's tag, read from where $releases/latest redirects
# (…/releases/tag/v0.1.0): the GitHub API limits the requests of callers without a token. A test's
# folder of releases holds the tag in its file `latest`. A pre-release is never the latest.
latest() {
  case "$releases" in
  file://*)
    fetch "$releases/latest" "$stage/latest"
    where="tag/$(cat "$stage/latest")"
    ;;
  *)
    if [ "$downloader" = curl ]; then
      where="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest" </dev/null)" ||
        fail "cannot read the latest release from $releases/latest"
    else
      # wget prints each redirect's Location; the last is the release's page.
      where="$(wget -q -S --spider "$releases/latest" </dev/null 2>&1 |
        sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')"
    fi
    ;;
  esac
  case "$where" in
  */tag/v* | tag/v*) printf '%s\n' "${where##*tag/}" ;;
  *) fail "cannot read the latest release from $releases/latest (it led to '$where')" ;;
  esac
}

# openssl3 prints the path of an OpenSSL 3 or later, which can verify ed25519, or nothing.
openssl3() {
  for candidate in $openssl_candidates; do
    if command -v "$candidate" >/dev/null 2>&1; then
      case "$("$candidate" version 2>/dev/null </dev/null)" in
      "OpenSSL "[3-9].* | "OpenSSL "[1-9][0-9]*)
        command -v "$candidate"
        return
        ;;
      esac
    fi
  done
}

# node_verify verifies the signature $3 of the file $1 with the PEM key $2 with a Node on the PATH:
# exits 0 where it verifies, 1 where it doesn't, 2 where this Node can't tell.
node_verify() {
  node -e 'let crypto, fs
try { crypto = require("node:crypto"); fs = require("node:fs") } catch { process.exit(2) }
const [data, key, signature] = process.argv.slice(1).map(file => fs.readFileSync(file))
let ok
try { ok = crypto.verify(null, data, crypto.createPublicKey(key), signature) } catch { process.exit(2) }
process.exit(ok ? 0 : 1)' "$1" "$2" "$3" </dev/null >/dev/null 2>&1
}

# verify_signature checks checksums.txt.sig with the release keys, or says why it can't.
verify_signature() {
  printf '%s\n' "$keys" | awk -v dir="$stage" '
    /-----BEGIN PUBLIC KEY-----/ { n++; file = dir "/key" n ".pem" }
    file != "" { print > file }
    /-----END PUBLIC KEY-----/ { close(file); file = "" }'
  openssl="$(openssl3)"
  verifier=
  if [ -n "$openssl" ]; then
    verifier=openssl
  elif command -v node >/dev/null 2>&1; then
    verifier=node
  fi
  for key in "$stage"/key*.pem; do
    [ -f "$key" ] || break
    case "$verifier" in
    openssl)
      if "$openssl" pkeyutl -verify -pubin -inkey "$key" -rawin -in "$stage/checksums.txt" \
        -sigfile "$stage/checksums.txt.sig" >/dev/null 2>&1 </dev/null; then
        say "Verified the signature of checksums.txt with the release key."
        return
      fi
      ;;
    node)
      status=0
      node_verify "$stage/checksums.txt" "$key" "$stage/checksums.txt.sig" || status=$?
      case "$status" in
      0)
        say "Verified the signature of checksums.txt with the release key."
        return
        ;;
      2) verifier= ;;
      esac
      ;;
    esac
    [ -n "$verifier" ] || break
  done
  if [ -z "$verifier" ]; then
    say "The signature of checksums.txt wasn't checked: that needs OpenSSL 3 or later, or Node, and neither"
    say "is here (macOS's own openssl is LibreSSL, which can't verify ed25519; brew install openssl@3 provides one)."
    say "The archive's SHA-256 is still checked against checksums.txt."
    return
  fi
  fail "checksums.txt.sig doesn't verify checksums.txt with a release key: the release wasn't made by
Fabrica's release workflow, or was changed since. Nothing was installed."
}

# sha256 prints the SHA-256 of the file $1.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "neither sha256sum nor shasum is here to check the archive's SHA-256"
  fi
}

# folders sets engines, the folder the engine's versions are unpacked in; bin, ~/.local/bin, where
# fabrica is linked to the version installed; extra, FABRICA_INSTALL_DIR where it names another folder,
# empty where it doesn't; and dir, the folder the user runs fabrica from: extra, or else bin. It makes
# them all.
folders() {
  [ -n "${HOME:-}" ] || fail "HOME isn't set: the engine is installed under ~/.local/share/fabrica"
  engines="$HOME/.local/share/fabrica/engine"
  bin="$HOME/.local/bin"
  extra="${FABRICA_INSTALL_DIR:-}"
  mkdir -p "$engines" 2>/dev/null || fail "cannot make $engines"
  mkdir -p "$bin" 2>/dev/null || fail "cannot make $bin"
  [ -w "$bin" ] || fail "cannot write in $bin, where fabrica is always linked, since fabrica engine update
and the login service use that link: make it a folder of yours."
  if [ -n "$extra" ]; then
    mkdir -p "$extra" 2>/dev/null || fail "cannot make $extra"
    [ -w "$extra" ] || fail "cannot write in $extra: set FABRICA_INSTALL_DIR to a folder of yours on the PATH,
curl -fsSL $script_url | FABRICA_INSTALL_DIR=<folder> sh"
    # The same folder, named another way, gets no link of its own, which would name itself.
    if [ "$(CDPATH='' cd "$extra" && pwd -P)" = "$(CDPATH='' cd "$bin" && pwd -P)" ]; then
      extra=
    fi
  fi
  dir="${extra:-$bin}"
}

# relink makes $2 a link to $1 beside it and renames it over $2, so that $2 never names nothing.
relink() {
  link="${2%/*}/.fabrica-install-$$"
  ln -s "$1" "$link" || fail "cannot write in ${2%/*}"
  mv -f "$link" "$2" || fail "cannot replace $2"
  link=
}

# after says how to put dir on the PATH when it isn't there, or that another fabrica comes first.
after() {
  case ":$PATH:" in
  *":$dir:"*)
    first="$(command -v fabrica 2>/dev/null || true)"
    if [ -n "$first" ] && [ "$first" != "$dir/fabrica" ]; then
      say ""
      say "$first comes before $dir on your PATH, so 'fabrica' still runs that one: remove it, or"
      say "put $dir before its folder."
    fi
    ;;
  *)
    say ""
    say "$dir isn't on your PATH. To add it:"
    case "${SHELL:-}" in
    */zsh) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    */bash)
      if [ "$os" = darwin ]; then
        say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bash_profile && exec bash -l"
      else
        say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bashrc && exec bash"
      fi
      ;;
    */fish) say "  fish_add_path $dir" ;;
    *) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile, then log in again" ;;
    esac
    ;;
  esac
  say ""
  say "Next: 'fabrica --help' lists its commands, and 'fabrica engine update' installs later releases."
}

main() {
  keys="$release_keys"
  if [ -n "${FABRICA_DOWNLOAD_URL:-}" ]; then
    releases="$FABRICA_DOWNLOAD_URL"
    keys="${FABRICA_TEST_RELEASE_KEY:-$keys}"
    cpuinfo="${FABRICA_TEST_CPUINFO:-$cpuinfo}"
    openssl_candidates="${FABRICA_TEST_OPENSSL-$openssl_candidates}"
    ldconfig_candidates=
    lib_dirs="${FABRICA_TEST_LIB_DIRS:-}"
    say "Test mode: downloading from $releases"
  fi
  case "$keys" in
  *"-----BEGIN PUBLIC KEY-----"*) ;;
  *) fail "this install script holds no release key yet, so it can't tell a release made by Fabrica's
release workflow from another. Nothing was installed." ;;
  esac

  platform
  rosetta
  if [ "$os" = darwin ]; then
    macos
  else
    if [ -z "${FABRICA_DOWNLOAD_URL:-}" ]; then
      lib_dirs="/lib /lib64 /usr/lib /usr/lib64 /lib/$machine-linux-gnu /usr/lib/$machine-linux-gnu"
    fi
    linux
  fi
  cpu
  target="$os-$arch"
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1; then
    downloader=wget
  else
    fail "neither curl nor wget is here to download the release"
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack the release"

  folders
  # Downloaded and unpacked in a folder of the engine's own, never in /tmp, which hardened hosts mount
  # noexec: the new fabrica runs where it is installed.
  stage="$engines/.install-$$"
  link=
  rm -rf "$stage"
  mkdir "$stage" || fail "cannot write in $engines"
  trap 'rm -rf "$stage"; [ -z "$link" ] || rm -f "$link"' EXIT
  trap 'exit 1' HUP INT TERM

  tag="${FABRICA_VERSION:-}"
  if [ -z "$tag" ]; then
    tag="$(latest)"
  fi
  case "$tag" in
  v*) ;;
  *) tag="v$tag" ;;
  esac
  version="${tag#v}"
  name="fabrica-$version-$target"
  archive="$name.tar.gz"

  say "Installing the Fabrica engine $tag for $target."
  fetch "$releases/download/$tag/checksums.txt" "$stage/checksums.txt"
  fetch "$releases/download/$tag/checksums.txt.sig" "$stage/checksums.txt.sig"
  # Verified before any sum in it is trusted, or the archive downloaded.
  verify_signature
  want="$(awk -v name="$archive" '$2 == name { print $1 }' "$stage/checksums.txt")"
  [ -n "$want" ] || fail "checksums.txt has no sum for $archive: release $tag has no engine for $target"
  fetch "$releases/download/$tag/$archive" "$stage/$archive"
  got="$(sha256 "$stage/$archive")"
  [ "$got" = "$want" ] || fail "$archive's SHA-256 is $got, not checksums.txt's $want. Nothing was installed."
  mkdir "$stage/x"
  tar -xzf "$stage/$archive" -C "$stage/x" </dev/null || fail "cannot unpack $archive"
  new="$stage/x/$name"
  [ -x "$new/bin/fabrica" ] || fail "$archive holds no $name/bin/fabrica"

  # Only its stdout is its version, as fabrica engine update reads it, so that a warning on stderr
  # doesn't fail the install.
  status=0
  said="$("$new/bin/fabrica" --version </dev/null 2>"$stage/stderr")" || status=$?
  if [ "$status" -ne 0 ]; then
    why="it exited $status"
    if [ -s "$stage/stderr" ]; then why="$why: $(cat "$stage/stderr")"; fi
    fail "the new engine doesn't run: $why"
  fi
  [ "$said" = "fabrica $tag" ] || fail "the new engine's fabrica --version says '$said', not fabrica $tag"

  # A version installed already is moved aside, into the stage that is removed at the end, and the new
  # one renamed into its place; then the link is made beside the old and renamed over it, so that
  # 'fabrica' never names a half-written engine.
  if [ -e "$engines/$version" ]; then
    mv "$engines/$version" "$stage/old" || fail "cannot replace $engines/$version"
  fi
  mv "$new" "$engines/$version" || fail "cannot write $engines/$version"
  relink "$engines/$version/bin/fabrica" "$bin/fabrica"
  say "Installed the Fabrica engine $tag in $engines/$version, linked from $bin/fabrica."
  if [ -n "$extra" ]; then
    relink "$bin/fabrica" "$extra/fabrica"
    say "Linked $extra/fabrica to $bin/fabrica, which fabrica engine update switches to later releases."
  fi
  after
}

main "$@"
