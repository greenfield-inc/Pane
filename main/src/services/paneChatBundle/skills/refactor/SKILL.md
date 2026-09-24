---
name: refactor
description: Post-PR refactor pass. Sizes the diff against the remote default branch, fans out refactor-simple (and refactor-deep on large changes) as fresh subagents that run blind to each other, merges their plans once with max-severity rules, shows the merged report, and hands it to refactor-apply on the user's word. Use after a PR is open, or whenever the user asks to refactor or clean up the branch.
argument-hint: "[--size=small|large] [--plan-only]"
---

# Refactor

One command for the post-PR quality pass. It sizes the change, runs the right
analyses independently, merges once, stops for the user, then applies. It
is a manual post-PR quality pass. It changes the head, so run it before
QA when QA evidence must be current-head evidence.

## Why the analyses run blind

Two analyses that see each other's findings converge into one opinion. Run
independently, `refactor-simple` and `refactor-deep` overlap on about half
their findings, the other half is complementary, and the severe correctness
findings tend to come from one of them alone. So each analysis runs in a
fresh subagent with no access to the other's output, and the merge happens
exactly once, here, after both are done. Repeated runs on the same diff
converge on the same findings, and averaging them has demoted real Criticals;
one run per analysis is the rule.

## Process

### 1. Size the change

Resolve the PR/current branch's relevant remote and that remote's default
branch before running these commands. If either is ambiguous or unavailable,
report the blocked comparison; do not guess a remote or silently review an
empty diff. Record the resolved remote, base ref, and merge-base for helpers.

```bash
# Resolve the relevant remote from the PR/current branch configuration first.
# Set REFACTOR_REMOTE to that verified name; do not assume origin.
git remote show "$REFACTOR_REMOTE"
# Resolve its actual default branch and set BASE to the verified remote ref.
# Fetch that branch explicitly if the ref is missing/stale, then verify it.
git rev-parse --verify "$BASE^{commit}"
git diff "$(git merge-base "$BASE" HEAD)" --numstat
```

Also enumerate non-ignored untracked files with
`git ls-files --others --exclude-standard -z`. Treat these as added files:
include their full contents and handwritten line counts in sizing and analysis,
applying the same generated/vendor/lockfile exclusions. Pass this file inventory
to every analyzer; plain `git diff` omits it. Do not stage files to inspect them.


Merge-base to working tree, so uncommitted work counts; the remote's real
default branch, not an assumed `main`.

Exclude lockfiles, generated files, and vendored directories from the count.
Under ~10 hand-written files and ~500 lines is **small**; above is **large**.
`--size` overrides. State the size and the file count before fanning out.

### 2. Fan out, independently

Use one fresh subagent per refactoring assignment.
`refactor-simple`, `refactor-deep`, and `refactor-apply` are skill modes, not
separate agent types. The parent orchestrates dispatch; a leaf instance cannot
spawn helpers and returns to the parent at those gates. Reuse one apply instance
for authorized edits and fixes, while independent reviews get fresh instances.

Each analysis runs as a separate fresh-context subagent (the available native subagent API and configured roles, one
per analysis, launched together when capacity permits). Each
subagent invokes its skill and returns the absolute path of the plan it wrote.
Pass the skill, worktree, and parent model/effort and no-archive requirements, without another reviewer’s findings.

- **small**: `refactor-simple` only.
- **large**: `refactor-simple` and `refactor-deep`, concurrently.

For a comprehensive review or a large change needing specialist coverage, use
[the specialist lenses](references/specialist-review.md). Selected scoped deep
reviews replace the broad deep pass rather than duplicate it; retain the simple
pass. Run applicable lenses in waves within capacity, not an unconditional
all-at-once fanout. Pass an explicit read-only scope override and distinct output
path to each instance. No reviewer publishes or edits code.

Each writes its own file under `./tmp/`, and reads only its own.

### 3. Merge once

Read every plan and produce one merged report at
`./tmp/refactor-merged-[timestamp].md`. Rules, in priority order:

1. **Cluster** findings that point at the same file/area and the same
   underlying issue, even if worded differently.
2. **Keep the maximum severity.** A finding that is Critical in one plan and
   Warning in another is Critical. A reproduced defect keeps its reproduction.
3. **Sole-source findings are kept.** Corroboration is not required; the
   independent runs are expected to disagree, and the disagreement is signal.
4. **Tag every item** with its source (`[S]`, `[D]`, named specialist lenses, or their combination), so the
   reader can see who found what.
5. **Carry each plan's quality score as reported**, plus the merged
   Critical/Warning/Info counts. The merged report has no combined score.
6. Pre-existing-not-against-this-PR items stay in Info, unchanged.

Keep every item's `file:line`, fix, and auto-fixable flag from its source
plan. The merged report is the same shape as the individual plans, so
`refactor-apply` reads it unchanged.

### 4. Stop for the user

Run `cold-read` on the merged report first: a person reads it to decide what
to change in their code. The cold-read may reorder, retitle, and clarify;
severities, findings, and `file:line` stay as written. Then show it, Criticals
in full, Warnings and Info summarised, with the auto-fixable and manual
counts, and stop. This is the gate: nothing
is applied until the user says so. `--plan-only` ends here.

Auto-fixable items are the safe class; still show them. Manual items always
wait for the user's judgment on each.

### 5. Apply, then prove it

On the user's go, invoke `refactor-apply` on the merged report, auto-fixable
first, then manual with the user. `refactor-apply` leaves its edits
uncommitted; this step commits them as one scoped commit named for the plan
and the round, so the adversary has an exact diff. Every repair is committed
the same way before its review.

Then run the adversarial loop as one continuous chain, and report when it
ends. Three review passes is the cap.

1. **Pass 1 reviews the apply commit.** A fresh subagent reads that commit's
   diff alone (`git diff <sha>~1..<sha>`), briefed to prove it broke
   something: every claim in the apply report is a claim to falsify; a
   behaviour-preserving change must have preserved behaviour; a consolidation
   must keep every edge case a caller relied on. A test that claims to fix a
   defect runs on the parent (must fail) and the head (must pass);
   characterization tests for behaviour-preserving changes may pass on both.
   It returns CLEAN, or REGRESSION with `file:line` and a repro.
2. **On REGRESSION, the applier repairs, then two reviewers look.** The
   repro goes back to the apply session, which knows the code; the repair is
   committed with the repro as a test proven failing on its parent. Then, in
   the same message: the reviewer who found the finding gets the repair as a
   follow-up in its own session, to re-run its repro and say whether that
   finding is closed; and a fresh subagent reads the repair commit's diff
   alone, briefed to break the repair itself, since a repair that changed
   code can break an adjacent case the first reviewer was primed to look
   past. The follow-up settles the finding; the fresh pass is the numbered
   pass and counts toward the cap.
3. **Pass 3 is the last.** Reaching it means each repair fixed the reported
   inputs and broke the next; the repair before pass 3 is spec-driven: the
   applier writes the input class as a test table, or replaces the mechanism
   with a pure derivation, and stops rather than commits when the correct fix
   needs scope beyond the files at hand. Whatever pass 3 finds goes to the
   user with the plan.

A CLEAN pass advances. At the cap, advance anyway: the survivors are reported
as open Criticals beside the delta, and the user decides. Then re-run the
analyses (step 2, fresh subagents) once and show the delta: what closed,
what remains, anything new.

On the first real run, two apply commits passed every check and their own new
tests, and the adversary found a reproduced regression in each; the repairs
then broke adjacent cases twice, with tests that passed trivially. The
adversary told to falsify caught all of it.

## Rules

- Steps 1-4 modify no tracked files. Only step 5 edits code, and only after
  the user's explicit go.
- Analyses run in fresh subagents, blind to each other; a plan stays out of
  every other analysis.
- Merge means cluster and keep the maximum severity.
- If a subagent fails or returns no plan, say so and merge what exists.
- The adversarial loop runs in one chain. Waiting on a human between rounds
  turns ten minutes of agent work into hours; report at the end.
- The reviewer who found a finding verifies its repair, in its own session;
  a fresh reviewer hunts what the repair introduced. Two questions, two
  readers.
