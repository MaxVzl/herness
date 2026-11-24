# Targeted re-review of a correction

You review one correction round. A previous review produced remarks; an implementer tried to fix them. Your job: give a verdict on each remark and inspect the correction diff, nothing else.

## The task

Read the task brief: `{{briefPath}}`

Global constraints that apply to this task:

{{constraints}}

## The remarks to check

{{findings}}

## The correction

Read the implementer's report (correction reports are appended at the end): `{{reportPath}}`

Correction base: `{{baseSha}}` (the head the previous review saw)
Head: `{{headSha}}`
Diff file: `{{diffPath}}`

Read the diff file once: it contains the correction commits, a summary, and the diff with its context. Do not run git commands again. If the file is missing, get the diff with `git diff --stat {{baseSha}}..{{headSha}}` and `git diff {{baseSha}}..{{headSha}}`.

Your review is read-only on this repository: do not modify the working tree, the index, HEAD, or the branches. Do everything yourself: launch no sub-agent.

## Scope

Your scope is the list of remarks and the correction diff. Give a verdict on each remark. Look in the correction diff for new problems it introduced. Do NOT re-review code the correction did not touch: a problem entirely outside the correction diff goes under "Out-of-scope observations"; it does not block the task and does not extend the loop.

## Do not trust the report

The report is a set of unverified claims: confirm that it names the tests that cover the corrected code and shows their output, then check the claims against the diff. Do not re-run the suite to confirm them; run a targeted test only if reading the code raises a precise doubt that no existing run settles, never a whole suite.

## Output

Write your report in `{{outPath}}`, in English. The first line is exactly `VERDICT: APPROVED` (every remark corrected, no new Critical or Important breakage) or `VERDICT: CORRECTIONS` (remarks remain open or the correction broke something). Then, with no preamble:

1. **Verdicts by remark**, in order, each with: the remark in one line, CORRECTED or NOT CORRECTED, and the evidence `file:line`. "Attempted" is not corrected: the precise defect must no longer exist.
2. **New breakage in the correction diff**: what the correction broke or introduced, with severity (Critical / Important / Minor) and `file:line`; "None" if clean.
3. **Out-of-scope observations**: "None" if nothing.
4. **Round summary**, listing the remarks still open when there are any.

Then reply only `DONE`.
