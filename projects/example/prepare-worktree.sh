#!/usr/bin/env bash
# EXAMPLE script that prepares a worktree; adapt it to your project.
# Usage: prepare-worktree.sh <worktree>
set -euo pipefail

wt=${1:?missing worktree}
[ -d "$wt" ] || { echo "worktree not found: $wt" >&2; exit 1; }
# The main checkout is the first entry of `git worktree list`.
main=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')

# Copy the .env (gitignored) from the main checkout if the worktree lacks it.
if [ -f "$main/.env" ] && [ ! -f "$wt/.env" ]; then
  cp "$main/.env" "$wt/.env"
fi

# Dependencies.
if [ -f "$wt/package.json" ]; then
  npm --prefix "$wt" ci
fi
echo "worktree ready: $wt"
