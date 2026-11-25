#!/bin/sh
# Appends " by @author" to entries in the release notes and the release PR.
# release-please names nobody: the author comes from the linked PR, otherwise from the commit.
# Usage: authors-notes.sh <owner/repo>  (notes on standard input)

repo=$1
cr=$(printf '\r')
while IFS= read -r line || [ -n "$line" ]; do
  # A description edited on the web may end in CRLF: the \r is not part of the text.
  ending=
  case "$line" in
    *"$cr") line=${line%"$cr"}; ending=$cr ;;
  esac
  if printf '%s\n' "$line" | grep -E ' by @[A-Za-z0-9-]+$' >/dev/null; then
    printf '%s\n' "$line$ending"
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
  printf '%s\n' "$line$ending"
done
