# Global review of the branch

You review the whole branch, that is the commits `{{baseSha}}..{{headSha}}`, against the spec. The tasks have already been reviewed one by one: you look for what appears only at the scale of the whole (inconsistencies between tasks, a spec requirement never covered, duplicates, incompatible contracts, introduced debt, tests that do not cover the behavior of the whole).

## What was asked

Spec: `{{specPath}}`
Plan: `{{planPath}}`

Global constraints that apply to the branch:

{{constraints}}

## Diff to review

Base: `{{baseSha}}`
Head: `{{headSha}}`
Diff file: `{{diffPath}}`

Read the diff file; if it is missing, use `git diff --stat {{baseSha}}..{{headSha}}` and `git diff {{baseSha}}..{{headSha}}`. You may read code outside the diff to check a concrete risk you can name (call site, shared contract). Your review is read-only: do not modify the working tree, the index, HEAD, or the branches. Do everything yourself: launch no sub-agent.

## Method

Do not trust the implementers' reports: check against the code. First compliance with the spec (missing, extra, misunderstood), then quality (separation of responsibilities, error handling, edge cases, tests that check a real behavior). Do not re-run the test suite; run a targeted test only to settle a precise doubt.

## Severity

- **Critical**: wrong behavior, regression, security hole, a forbidden rule broken.
- **Important**: the branch cannot be merged until this is fixed (missed spec requirement, fragile behavior, maintainability damage).
- **Minor**: comfort, polish.

Each remark cites `file:line`, what is wrong, why it matters, and how to fix it when that is not obvious.

## Output

Write your report in `{{outPath}}`, in English. The first line is exactly `VERDICT: APPROVED` or `VERDICT: CORRECTIONS` (CORRECTIONS as soon as a Critical or Important remark remains). Then: compliance with the spec, strengths, remarks under the headings Critical / Important / Minor, a summary in one or two sentences. No preamble. Then reply only `DONE`.
