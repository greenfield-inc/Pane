---
name: refactor-simple
description: Read-only code quality analysis of the branch against the remote default branch for small to medium changes - classifies the diff, derives conventions from the target repo, and writes a refactor plan to ./tmp/. Usually run by the refactor orchestrator; use directly for a quick pre-PR check on 2-10 files.
---

# Simple Refactor

**Read-only code quality analysis for small to medium changes.**

Safe to run anytime. Analyzes the branch against the target repository's own
conventions and writes a refactor plan without modifying files.

## What This Does

Fast, focused code quality analysis that:
1. Classifies your changes (size, type, complexity)
2. Learns the conventions of the repository you are in
3. Identifies code smells and convention violations in the lines you changed
4. Generates a refactor plan with auto-fixable and manual issues
5. Writes the plan to `./tmp/` for review

## When to Use

- **Small changes** (2-5 files, 50-200 lines)
- **Medium changes** (5-10 files, 200-500 lines)
- **Bug fixes** and **enhancements**
- Quick pre-PR quality check

For large features (>10 files, >500 lines), use `refactor-deep` instead. Simple and
deep are the whole set: simple is the cheap pass with the cleanest
signal-to-noise, deep is the one that finds real defects in big diffs. Run
both on a large PR when you want coverage; their findings overlap by about
half and the rest is complementary.

## Process

### 1. Classify Changes

Diff against the merge-base with the remote default branch, never a bare local
`main` - a stale local `main` pulls unrelated commits into the review and every
finding in them becomes a false positive.

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
MB=$(git merge-base "$BASE" HEAD)
git diff "$MB" --name-status
git diff "$MB" --numstat
git diff "$MB" --stat
```

Also enumerate non-ignored untracked files with
`git ls-files --others --exclude-standard -z`. Treat these as added files:
include their full contents and handwritten line counts in sizing and analysis,
applying the same generated/vendor/lockfile exclusions. Pass this file inventory
to every analyzer; plain `git diff` omits it. Do not stage files to inspect them.


`$BASE` is the remote's real default branch (`main`, `master`, `develop`),
never an assumed name. Diffing from the merge-base to the working tree - one
revision, not two - includes committed, staged, and unstaged work, so a
pre-PR run sees the edits that are not committed yet.

If the branch is behind `$BASE`, note it once as "rebase before merge"; it is
not a finding and does not lower the score.

**Determine:**
- **Size**: Tiny (<50) | Small (50-200) | Medium (200-500)
- **Type**: Bug Fix | Enhancement | Refactor
- **Complexity**: Trivial | Simple | Moderate
- **Layers**: Backend | Frontend | Both

Size counts changed source lines. A lockfile, generated file, or vendored
directory can add thousands of lines and no complexity - say so and classify
on the hand-written change.

### 2. Learn the Repository's Conventions

Conventions come from the repository you are in, never from a rule remembered
from another repo. In order:

1. Read `CLAUDE.md` / `AGENTS.md` at the root and in every directory the diff
   touches. These state the conventions the maintainers actually enforce.
2. Read two or three exemplar files that neighbour the changed code - files
   the maintainers clearly consider done - and note how they import, structure,
   handle errors, and document.
3. Before flagging any convention violation, confirm the convention exists
   here. `grep` how many existing files already do the thing. If the codebase
   does it everywhere, it is the convention, not a violation.

An import style is a finding only when the target repository's guidance and
existing code establish that convention. Explain the actual impact rather than
assigning severity from a preference remembered from another project.

**Pattern Matrix:**
- **Tiny/Bug Fix** → Universal smells only
- **Small/Enhancement** → Universal + the repo's basic architecture rules
- **Medium** → Universal + architecture + documentation for new files

**Universal Smells (any repository):**
- Long functions (>100 lines), deep nesting (>3 levels)
- Magic numbers/strings
- Missing or swallowed error handling on new paths
- Unused imports/variables, commented-out code, TODOs without context
- Duplicate logic: two similar functions, hooks, or types where one with
  options would do
- New public surface without a file-level or symbol-level comment when the
  neighbouring code has them

**Repo-Derived Rules (Small+):** import style, layering (where logic is allowed
to live), state-management and hook patterns, error types, test conventions -
whatever steps 1-3 above surfaced, cited to the file that states them.

### 3. Analyze Files

Read the changed files and the non-ignored untracked file inventory gathered above:
```bash
git diff "$MB" --name-only
```

**Pre-existing vs introduced:** only issues in lines this branch adds or
changes count against the PR. Pre-existing debt in touched files may be listed
under Info as "pre-existing, not against this PR" and never lowers the score.
Read enough surrounding code to tell the difference - a `git blame` on the
line settles it.

### 4. Generate Report

Write the plan to `./tmp/simple-refactor-plan-[timestamp].md`:

```markdown
# Simple Refactor Plan

## Classification
- Size: [X] ([N] hand-written lines; [M] generated/lockfile lines excluded)
- Type: [X]
- Complexity: [X]
- Diff base: merge-base with $BASE at [sha], to working tree
- Conventions sourced from: [files read in step 2]

## Quality Score: X/10

## Issues Found

### Critical (Must Fix)
- [file:line] Description
  → Convention: [file that states it, or "universal"]
  → Fix: How to fix
  → Auto-fixable: Yes/No

### Warnings (Should Fix)
- [file:line] Description
  → Suggestion: Improvement
  → Auto-fixable: Yes/No

### Info (Nice to Have)
- [file:line] Suggestion
- [file:line] Pre-existing, not against this PR: description

## Auto-Fixable Issues: X
## Manual Fixes Required: Y

## Convention Compliance
✓/✗ [each repo-derived rule checked, with its source file]

## Recommendations
1. Hand this plan to `refactor-apply` (auto-fixable first)
2. Manually fix [specific issues]
3. Re-run `refactor-simple` to verify

## References
- Exemplar files studied: [paths]
- Convention sources: [paths]
```

An empty Critical section is a valid, common result. Do not manufacture
findings to fill the template; "no PR-introduced defects" is the honest
baseline for a clean change and should score accordingly.

### 5. Show Next Steps

```
📊 Analysis complete!
Plan written to: ./tmp/simple-refactor-plan-[timestamp].md
Quality Score: X/10
Auto-fixable: X issues · Manual fixes: Y issues
Issues found: [one line each for criticals and warnings]

Return the plan path to the caller. When run standalone, ask before running `refactor-apply`.
```

**IMPORTANT:** This skill never applies fixes. Standalone, ask the user
before proceeding to `refactor-apply`; under `refactor`, the orchestrator
owns that gate.

## Command Arguments

- `--strict`: Treat Medium as Large (stricter enforcement)
- `--classify-as=<type>`: Override type classification
- `--size=<size>`: Override size classification

## Success Checklist

- [ ] Diffed from the merge-base with the remote default branch to the working tree
- [ ] Changes classified, generated lines excluded from size
- [ ] Conventions read from THIS repo's guidance files and exemplars
- [ ] Every convention finding confirmed by grep before it was written
- [ ] Pre-existing debt separated from PR-introduced issues
- [ ] Auto-fixable vs manual separated
- [ ] Plan written to ./tmp/
- [ ] No files modified (read-only)

---

**This command is read-only and safe.** It analyzes code against the
conventions of the repository you are in and writes a refactor plan for you
to review. Run `refactor-apply` after reviewing the plan to apply fixes.
