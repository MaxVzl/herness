# Correction

You are picking up a task whose delivery must be corrected. Do not leave the scope of the original task; read the task brief and the repository rules (`AGENTS.md`, `.cursor/rules/`) if you do not already have them in mind.

## Language

- Write commit messages in {{language}}.
- Write comments and test names following the conventions of the surrounding code, and in {{language}} when it has none.
- Write the report in English.

## What to address

Review remarks to address (one per line, with `file:line`):

{{findings}}

Red test output to address, if any:

{{failure}}

If either section is empty, ignore it. Fix the cause, not the symptom: do not weaken or delete a test to get to green. Follow TDD: a test that reproduces the defect first, seen red, then the minimal fix, then green.

## Tests

Re-run the tests that cover the corrected code (those of the task, not the full suite) and check that they pass. Commit the correction with the same message format as the task, with hooks enabled.

## Forbidden

{{forbidden}}

Git identity: commit with the configured identity, as it is. Forbidden: `--author`, `git -c user.name=…` or `git -c user.email=…`, the variables `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, and any `git config` command. If the commit fails for lack of an identity, stop and report it. If something blocks you, stop and explain rather than working around it.

## Report

Describe, remark by remark, what you did or why you did not, with the files modified, the test command you ran and its real result, the commit hash, and any uncertain point.

Append this report to the end of `{{reportPath}}`, without erasing earlier reports, then reply only `DONE`.
