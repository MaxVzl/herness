#!/usr/bin/env bash
# EXEMPLE de script de préparation d'un worktree, à adapter à ton projet.
# Usage : prepare-worktree.sh <worktree>
set -euo pipefail

wt=${1:?worktree manquant}
[ -d "$wt" ] || { echo "worktree introuvable : $wt" >&2; exit 1; }
# Le checkout principal est la première entrée de `git worktree list`.
main=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')

# Copie le .env (gitignoré) du checkout principal s'il manque dans le worktree.
if [ -f "$main/.env" ] && [ ! -f "$wt/.env" ]; then
  cp "$main/.env" "$wt/.env"
fi

# Dépendances.
if [ -f "$wt/package.json" ]; then
  npm --prefix "$wt" ci
fi
echo "worktree prêt : $wt"
