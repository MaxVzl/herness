#!/bin/sh
# Installs (or updates) herness from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --version 0.5.0
#
# Contract with releases, independent of herness's language: each release carries
# an archive `herness-<version>.tar.gz` (a single root folder) that contains an
# executable `bin/herness`, and optionally `bin/post-install`, run once after
# extraction to prepare the version (dependencies…).
#
# Each version lives in its own folder; `current` points at the active version
# and `~/.local/bin/herness` at `current/bin/herness`. A process started before an
# update keeps its version intact. The 3 latest versions are kept (roll back with
# --version), except those a process is still using.
set -eu

REPO=MaxVzl/herness
DATA=${HERNESS_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/herness}
BIN_DIR=${HERNESS_BIN_DIR:-$HOME/.local/bin}
RELEASES_URL=${HERNESS_RELEASES_URL:-https://github.com/$REPO/releases/download}
LATEST_URL=${HERNESS_LATEST_URL:-https://api.github.com/repos/$REPO/releases/latest}
KEEP=3

die() { echo "herness: $*" >&2; exit 1; }

usage() {
  echo "usage: install.sh [--version <x.y.z>]"
  echo "Installs the latest herness version, or the one requested, into $DATA."
}

version=
while [ $# -gt 0 ]; do
  case $1 in
    --version) [ $# -ge 2 ] || die "--version expects a version"; version=$2; shift 2 ;;
    --version=*) version=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
version=${version#v}

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v tar >/dev/null 2>&1 || die "tar not found"

if [ -z "$version" ]; then
  version=$(curl -fsSL "$LATEST_URL" | sed -n 's/.*"tag_name"[^"]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1) \
    || die "cannot reach $LATEST_URL"
  [ -n "$version" ] || die "latest version not found ($LATEST_URL)"
fi
case $version in
  *[!0-9A-Za-z.+-]*|'') die "invalid version: $version" ;;
esac

versions=$DATA/versions
dest=$versions/$version
previous=
[ -L "$DATA/current" ] && previous=$(basename "$(readlink "$DATA/current")")

# Marker name kept as written by 0.8 installs, so an existing copy is not fetched again.
if [ -f "$dest/.installe" ]; then
  echo "herness $version already present in $dest"
else
  mkdir -p "$versions"
  rm -rf "$dest"
  staging=$(mktemp -d "$versions/.$version.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  url=$RELEASES_URL/v$version/herness-$version.tar.gz
  echo "downloading $url"
  curl -fsSL "$url" -o "$staging/archive.tar.gz" || die "download failed: $url"
  mkdir "$staging/x"
  tar -xzf "$staging/archive.tar.gz" -C "$staging/x" --strip-components=1 || die "unreadable archive: $url"
  [ -x "$staging/x/bin/herness" ] || die "invalid archive: bin/herness missing or not executable"
  # Prepared in its final place: installed dependencies may record absolute paths there.
  mv "$staging/x" "$dest"
  if [ -x "$dest/bin/post-install" ]; then
    echo "preparing herness $version"
    if ! "$dest/bin/post-install"; then
      rm -rf "$dest"
      die "preparing herness $version failed: current version unchanged${previous:+ ($previous)}"
    fi
  fi
  : > "$dest/.installe"
fi

# Switch: the `current` link is replaced in one step (`mv -T`, GNU); elsewhere, `ln -sfn`.
ln -s "versions/$version" "$DATA/current.$$"
if ! mv -T "$DATA/current.$$" "$DATA/current" 2>/dev/null; then
  rm -f "$DATA/current.$$"
  ln -sfn "versions/$version" "$DATA/current"
fi

mkdir -p "$BIN_DIR"
link=$BIN_DIR/herness
target=$DATA/current/bin/herness
if [ -L "$link" ]; then
  old=$(readlink "$link")
  [ "$old" = "$target" ] || echo "old link replaced: $link pointed to $old"
elif [ -e "$link" ]; then
  die "$link exists and is not a link: move it, then run again"
fi
ln -sfn "$target" "$link"

# Cleanup: the $KEEP most recent versions stay, plus any version still in use.
kept=0
for v in $(ls -1 "$versions" | sort -r -V); do
  [ -d "$versions/$v" ] || continue
  kept=$((kept + 1))
  [ "$v" = "$version" ] && continue
  [ "$kept" -le "$KEEP" ] && continue
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "$versions/$v/" >/dev/null 2>&1; then
    echo "herness $v kept: still used by a process"
    continue
  fi
  rm -rf "${versions:?}/$v"
done

if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  echo "herness $previous → $version"
else
  echo "herness $version installed"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on PATH; add it to run herness" ;;
esac
