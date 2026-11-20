#!/bin/sh
# Ajoute « by @auteur » aux entrées des notes de release et de la PR de release.
# release-please ne nomme personne : l'auteur vient de la PR liée, sinon du commit.
# Usage : auteurs-notes.sh <propriétaire/dépôt>  (notes sur l'entrée standard)

repo=$1
cr=$(printf '\r')
while IFS= read -r line || [ -n "$line" ]; do
  # Une description éditée sur le web peut finir en CRLF : le \r ne fait pas partie du texte.
  fin=
  case "$line" in
    *"$cr") line=${line%"$cr"}; fin=$cr ;;
  esac
  if printf '%s\n' "$line" | grep -E ' by @[A-Za-z0-9-]+$' >/dev/null; then
    printf '%s\n' "$line$fin"
    continue
  fi
  who=
  pr=$(printf '%s\n' "$line" | grep -oE '\[#[0-9]+\]' | head -1 | tr -dc 0-9)
  if [ -n "$pr" ]; then
    who=$(gh pr view "$pr" --repo "$repo" --json author --jq .author.login 2>/dev/null) || who=
  fi
  if [ -z "$who" ]; then
    sha=$(printf '%s\n' "$line" | grep -oE '/commit/[0-9a-f]{40}' | head -1)
    sha=${sha#/commit/}
    if [ -n "$sha" ]; then
      who=$(gh api "repos/$repo/commits/$sha/pulls" --jq '.[0].user.login // empty' 2>/dev/null) || who=
    fi
  fi
  case "$who" in
    ''|*bot*|app/*) ;;
    *) line="$line by @$who" ;;
  esac
  printf '%s\n' "$line$fin"
done
