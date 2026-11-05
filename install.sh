#!/bin/sh
# Installe (ou met à jour) herness depuis une release GitHub.
#
#   curl -fsSL https://raw.githubusercontent.com/MaxVzl/herness/main/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --version 0.5.0
#
# Contrat avec les releases, indépendant du langage de herness : chaque release porte
# une archive `herness-<version>.tar.gz` (un seul dossier racine) qui contient un
# exécutable `bin/herness`, et éventuellement `bin/post-install`, lancé une fois après
# l'extraction pour préparer la version (dépendances…).
#
# Chaque version vit dans son propre dossier ; `current` pointe vers la version active
# et `~/.local/bin/herness` vers `current/bin/herness`. Un processus lancé avant une
# mise à jour garde sa version intacte. Les 3 dernières versions sont gardées (retour
# arrière : --version), sauf celles qu'un processus utilise encore.
set -eu

REPO=MaxVzl/herness
DATA=${HERNESS_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/herness}
BIN_DIR=${HERNESS_BIN_DIR:-$HOME/.local/bin}
RELEASES_URL=${HERNESS_RELEASES_URL:-https://github.com/$REPO/releases/download}
LATEST_URL=${HERNESS_LATEST_URL:-https://api.github.com/repos/$REPO/releases/latest}
KEEP=3

die() { echo "herness : $*" >&2; exit 1; }

usage() {
  echo "usage : install.sh [--version <x.y.z>]"
  echo "Installe la dernière version de herness, ou celle demandée, dans $DATA."
}

version=
while [ $# -gt 0 ]; do
  case $1 in
    --version) [ $# -ge 2 ] || die "--version attend un numéro"; version=$2; shift 2 ;;
    --version=*) version=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done
version=${version#v}

command -v curl >/dev/null 2>&1 || die "curl introuvable"
command -v tar >/dev/null 2>&1 || die "tar introuvable"

if [ -z "$version" ]; then
  version=$(curl -fsSL "$LATEST_URL" | sed -n 's/.*"tag_name"[^"]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1) \
    || die "impossible de joindre $LATEST_URL"
  [ -n "$version" ] || die "dernière version introuvable ($LATEST_URL)"
fi
case $version in
  *[!0-9A-Za-z.+-]*|'') die "version invalide : $version" ;;
esac

versions=$DATA/versions
dest=$versions/$version
previous=
[ -L "$DATA/current" ] && previous=$(basename "$(readlink "$DATA/current")")

if [ -f "$dest/.installe" ]; then
  echo "herness $version déjà présent dans $dest"
else
  mkdir -p "$versions"
  rm -rf "$dest"
  staging=$(mktemp -d "$versions/.$version.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  url=$RELEASES_URL/v$version/herness-$version.tar.gz
  echo "téléchargement de $url"
  curl -fsSL "$url" -o "$staging/archive.tar.gz" || die "téléchargement impossible : $url"
  mkdir "$staging/x"
  tar -xzf "$staging/archive.tar.gz" -C "$staging/x" --strip-components=1 || die "archive illisible : $url"
  [ -x "$staging/x/bin/herness" ] || die "archive invalide : bin/herness absent ou non exécutable"
  # Préparée à sa place définitive : les dépendances installées peuvent y noter des chemins absolus.
  mv "$staging/x" "$dest"
  if [ -x "$dest/bin/post-install" ]; then
    echo "préparation de herness $version"
    if ! "$dest/bin/post-install"; then
      rm -rf "$dest"
      die "préparation de herness $version échouée : version actuelle inchangée${previous:+ ($previous)}"
    fi
  fi
  : > "$dest/.installe"
fi

# Bascule : le lien `current` est remplacé d'un coup (`mv -T`, GNU) ; ailleurs, `ln -sfn`.
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
  [ "$old" = "$target" ] || echo "ancien lien remplacé : $link pointait vers $old"
elif [ -e "$link" ]; then
  die "$link existe et n'est pas un lien : déplace-le puis relance"
fi
ln -sfn "$target" "$link"

# Ménage : les $KEEP versions les plus récentes restent, et toute version encore utilisée.
kept=0
for v in $(ls -1 "$versions" | sort -r -V); do
  [ -d "$versions/$v" ] || continue
  kept=$((kept + 1))
  [ "$v" = "$version" ] && continue
  [ "$kept" -le "$KEEP" ] && continue
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "$versions/$v/" >/dev/null 2>&1; then
    echo "herness $v gardé : encore utilisé par un processus"
    continue
  fi
  rm -rf "${versions:?}/$v"
done

if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  echo "herness $previous → $version"
else
  echo "herness $version installé"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "attention : $BIN_DIR n'est pas dans le PATH ; ajoute-le pour lancer « herness »" ;;
esac
