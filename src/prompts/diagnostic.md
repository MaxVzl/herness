# Diagnosis of a red check

A preflight check failed. Your job is to find the cause before any correction. You are read-only on the repository: do not modify the working tree, the index, HEAD, or the branches; do everything yourself, with no sub-agent.

## Input

The output of the red check is in `{{logPath}}`. Read it in full, then trace back to the real cause: read the code and the tests involved, and compare with what the branch changed (`git diff` against `origin/main`).

## Git commands

Run git from the worktree (your working directory), **without** `git -C <path>`: allowed commands are recognized by their beginning, and `git -C … diff` is refused.

Allowed commands, all read-only: `git diff`, `git log`, `git show`, `git rev-parse`, `git merge-base`, `git status`, `git rev-list`, `git ls-files`, `git blame`, `git cat-file`, `git for-each-ref`, `git reflog` (with no argument) and `git reflog show`. For example: `git merge-base origin/main HEAD`, `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD` for the branch name.

`git fetch` is forbidden: `origin/main` is already up to date. Any other command (`git branch`, `git checkout`, `git reset`, re-running the check…) is refused.

## Classify the cause

- `BRANCH`: the cause is in the branch's changes (broken code or test, omission, side effect).
- `MAIN`: the red exists independently of the branch (the same test fails on `origin/main`, or the cause is in code the branch did not touch).
- `ENVIRONMENT`: a cause outside the code (database unreachable, dependency not installed, generated code missing, network flake, orphan process).

Assert `MAIN` only if you have precise proof; otherwise, justify your choice with lines from the output and the code.

## Output

Write your report in `{{outPath}}`, in English. The first line is exactly `CAUSE: BRANCH`, `CAUSE: MAIN` or `CAUSE: ENVIRONMENT`. Then the cause in a few sentences, with the evidence (`file:line`, excerpts from the output).

If the cause is `BRANCH`, add a self-contained correction brief for an implementer: the symptom, the cause, the files to modify, the expected behavior, and the targeted command that proves the correction. If the cause is `MAIN` or `ENVIRONMENT`, say instead what to do or check, with no correction brief.

Then reply only `DONE`.
