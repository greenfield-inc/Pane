---
name: refactor-deep
description: Read-only comprehensive analysis of the branch against the remote default branch for large features - derives conventions per layer, hunts for correctness defects in the new code paths, and writes a prioritized refactor plan to ./tmp/. Usually run by the refactor orchestrator alongside refactor-simple; use directly on 10+ file changes.
---

# Deep Refactor

**Comprehensive read-only analysis for large features and architectural changes.**

Safe to run anytime. Performs deep analysis against the target repository's
own conventions, hunts for correctness defects in the new code paths, and
writes a detailed refactor plan without modifying files.

## What This Does

Thorough code quality analysis that:
1. Classifies changes with detailed metrics
2. Learns the conventions of the repository you are in, per layer
3. Analyzes each layer the diff touches against those conventions
4. Hunts for correctness defects in the new code paths (the part that finds
   real bugs - unguarded I/O, bypassed guards, lifecycle and cleanup gaps)
5. Checks cross-cutting concerns (SOLID, DRY, documentation, error handling)
6. Writes a comprehensive, prioritized plan to `./tmp/`

## When to Use

- **Large features** (10-20 files, 500-1000 lines)
- **Huge features** (20+ files, >1000 lines)
- **Architectural changes** requiring comprehensive validation
- **Pre-PR comprehensive check** for complex work

For small/medium changes, use `refactor-simple` instead. Simple and deep are the whole
set; on a large PR their findings overlap by about half and the rest is
complementary, so running both is coverage, not redundancy. Do not run this
command three times and merge the results - repeated runs on the same diff
converge on the same findings, and a merge step has been shown to lose the
severe ones.

## Process

### Phase 0: Classification & Convention Discovery

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

**Classify:**
- **Size**: Large (500-1000 lines) | Huge (>1000 lines) - of hand-written
  change. Lockfiles, generated files, and vendored directories are excluded
  from the count and named as excluded.
- **Type**: New Feature | Major Refactor | Enhancement
- **Complexity**: Complex | Very Complex - judged on the change, not the line
  count. A huge diff that is one mechanical operation is not Complex; say so.
- **Layers**: list them as this repository names them (for example
  main/preload/renderer in an Electron app; api/webapp in a monorepo)
- **Modules**: affected modules

**Discover conventions, per layer.** Conventions come from the repository you
are in, never from a rule remembered from another repo:

1. Read `CLAUDE.md` / `AGENTS.md` at the root and in every directory the diff
   touches.
2. For each layer, read two or three exemplar files that neighbour the changed
   code and note how they import, structure, handle errors, test, and document.
3. Before flagging any convention violation, confirm the convention exists
   here - `grep` how many existing files already do the thing. If the codebase
   does it everywhere, it is the convention, not a violation.

An import style is a finding only when the target repository's guidance and
existing code establish that convention. Explain the actual impact rather than
assigning severity from a preference remembered from another project.

**Show classification to user:**
```
📊 Change Classification:
Size:       Large (15 files, 742 hand-written lines; lockfile excluded)
Type:       New Feature (12 added, 3 modified)
Complexity: Complex (multiple modules)
Layers:     [as the repo names them, with file counts]
Modules:    [list]
Diff base:  merge-base with $BASE at [sha], to working tree

📋 Conventions sourced from:
[the guidance files and exemplars read in step 1-2]

Proceeding with comprehensive analysis...
```

### Phase 1: Per-Layer Convention Analysis

For each layer the diff touches, check the changed code against the
conventions discovered in Phase 0, citing the file that states each one.
Typical dimensions - fill them from the repository, do not assume:

- **Import style**: alias vs relative, ordering, allowed cross-layer imports
- **Layering**: where logic is allowed to live (handlers vs services, pages
  vs hooks, main vs renderer), and what must not leak across
- **Error handling**: the error types and propagation the repo uses; where
  try/catch is expected and where a wrapper handles it
- **State and data**: the repo's server-state / IPC / persistence patterns and
  the invariants that come with them (cache keys, invalidation, cleanup)
- **Structure**: file and folder placement rules, local-vs-shared conventions,
  when a subfolder with an index is expected
- **Tests**: what the repo tests and how; whether new surface has a test
  neighbouring code would have

For each checklist row, record the local rule, its source file/line, a nearby
example, and the changed code being evaluated. If the repository has no clear
rule for a row, mark it unestablished rather than inventing a framework,
service superclass, error type, validation library, or directory convention.

### Phase 2: Correctness Defects in New Paths

This is where deep earns its keep, and it does not shrink when the diff is
big. If budget is tight, a convention row can be dropped; a correctness
finding cannot - on Huge diffs, do this phase before Phase 1. For each new or
materially changed code path, ask what happens when it goes wrong, and read
far enough to answer:

- **Unguarded I/O**: child processes, sockets, streams, files. Is every
  `write`/`spawn` paired with an error handler? What happens on early exit,
  EPIPE, timeout, or a partial handshake? Would an unhandled error surface in
  the process's global handler - and does this process even have one?
- **Bypassed guards**: a check enforced in one entry point (a doctor, a
  validator, a platform gate, a permission check) - is it also enforced on
  every other entry point that reaches the same operation? Grep for the
  guard's usages.
- **Lifecycle and cleanup**: is every started thing stopped? Timers cleared,
  listeners removed, in-flight work cancelled on unmount/switch, process trees
  killed and not just the wrapper shell?
- **Stale state**: does state reset when its key changes (session, id,
  account)? Can a failure leave old data rendered beside a new error?
- **Boundary and platform assumptions**: paths, shells, environment
  (WSL/remote/browser), encodings; anything hardcoded that another platform
  would break.
- **Untested surface**: new logic with no test where neighbouring code has
  one - name the specific case that would have caught the defect above.

Every finding here cites `file:line`, states the concrete failure ("child
exits after `initialize` → EPIPE → uncaught in main process → error dialog"),
and - where cheap - is reproduced. A reproduced defect is Critical; a
plausible one is a Warning with the reproduction it needs.

### Phase 3: Cross-Cutting Concerns

**SOLID / SRP:** each service, hook, function has one clear purpose; no god
objects.

**DRY:** no duplicate blocks; shared logic in utilities or base types; a
single source of truth for each type.

**Configuration Object Pattern (CRITICAL):**
- ❌ Multiple similar functions → consolidate with an options parameter
  (`formatTime()`, `formatTimeCompact()` → `formatTime(date, { format })`)
- ❌ Similar hooks with variations → consolidate with options
- ❌ Two utilities imported for the same purpose → one with options
- ❌ Duplicate interface/type definitions → single source of truth
- ❌ Similar services with minor config differences → consolidate
- ✅ Same function called with different options is not duplication

**Documentation:** major files have a top-of-file comment where neighbouring
files do; complex units have JSDoc; non-obvious logic has inline comments;
TODOs carry context or an issue number.

**Error handling:** the repo's error types, no silent failures, no swallowed
rejections.

**Pre-existing vs introduced:** only issues in lines this branch adds or
changes count against the PR. Pre-existing debt in touched files may be
listed under Info as "pre-existing, not against this PR" and never lowers the
score. `git blame` settles it.

### Phase 4: Generate Comprehensive Report

Write to `./tmp/deep-refactor-plan-[timestamp].md`:

```markdown
# Deep Refactor Plan

## Classification
- Size: [Large/Huge] ([N] hand-written lines; [M] generated/lockfile excluded)
- Type: [X]
- Complexity: [Complex/Very Complex]
- Layers: [as the repo names them]
- Modules: [list]
- Files Changed: X added, Y modified, Z deleted
- Diff base: merge-base with $BASE at [sha], to working tree
- Conventions sourced from: [files]

## Quality Score: X/10

## Issues Found

### Critical Issues (Must Fix Before Merge)
- [file:line] Issue description
  → Failure: the concrete thing that goes wrong, reproduced: yes/no
  → Fix: detailed instructions
  → Convention: [file that states it] | "correctness"
  → Auto-fixable: Yes/No

### Warnings (Should Fix)
- [file:line] Issue description
  → Suggestion / Impact / Auto-fixable

### Info (Nice to Have)
- [file:line] Suggestion → Benefit
- [file:line] Pre-existing, not against this PR: description

## Auto-Fixable Issues: X
## Manual Fixes Required: Y
**Priority 1 (Blocking):** ...
**Priority 2 (Important):** ...
**Priority 3 (Nice to Have):** ...

## Convention Compliance Matrix
[one row per convention actually checked, with its source file; omit rows
that do not apply to this repo rather than marking them N/A]

## Quality Score Breakdown
- Correctness (Phase 2):  [X/10]
- Conventions (Phase 1):  [X/10]
- Cross-cutting (Phase 3): [X/10]
- Documentation:          [X/10]
**Overall: X/10** - target ≥ 9.8

## Recommendations
1. Hand this plan to `refactor-apply` (auto-fixable first)
2. Address Priority 1, then Priority 2
3. Re-run `refactor-deep` to verify

## References
- Exemplar files studied: [paths]
- Convention sources: [paths]
```

An empty Critical section is a valid result. Do not manufacture findings to
fill the template, and do not pad the compliance matrix with rows that do not
apply. "No PR-introduced defects" is the honest baseline for a clean change
and should score accordingly.

### Phase 5: Show Summary

```
📊 Deep Analysis Complete!
Plan: ./tmp/deep-refactor-plan-[timestamp].md
Quality Score: X/10 (target 9.8)
Files Analyzed: X · Critical: Y · Warnings: Z · Auto-fixable: W
Key Issues:
- [criticals, one line each - reproduced ones first]
- [warnings summary]

Return the plan path to the caller. When run standalone, ask before running `refactor-apply`.
```

**IMPORTANT:** This skill never applies fixes. Standalone, ask the user
before proceeding to `refactor-apply`; under `refactor`, the orchestrator
owns that gate.

## Command Arguments

- `--force-all-patterns`: Check all conventions regardless of classification
- `--classify-as=<type>`: Override type classification
- `--size=<size>`: Override size classification
- `--strict`: Warnings count as Critical for the score and the target rises to 10/10 - strict is never looser than the default 9.8

## Success Checklist

- [ ] Diffed from the merge-base with the remote default branch to the working tree
- [ ] Classified with generated lines excluded; complexity judged on the change
- [ ] Conventions read from THIS repo's guidance files and exemplars, per layer
- [ ] Every convention finding confirmed by grep before it was written
- [ ] Phase 2 correctness hunt done on every new path, findings cite file:line
- [ ] Cross-cutting concerns checked
- [ ] Pre-existing debt separated from PR-introduced issues
- [ ] Issues prioritized; auto-fixable vs manual identified
- [ ] Plan written to ./tmp/
- [ ] No files modified (read-only)

---

**This command is read-only and comprehensive.** It analyzes code against
the conventions of the repository you are in, hunts for correctness defects
in the new paths, and writes a detailed plan for you to review. For smaller
work, use `refactor-simple`. Run `refactor-apply` after reviewing the plan.
