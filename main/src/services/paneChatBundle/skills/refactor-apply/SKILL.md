---
name: refactor-apply
description: Applies a refactor plan written by refactor-simple, refactor-deep, or the refactor orchestrator's merged report - auto-fixable items first, then manual items one at a time with the user, verifying with the repo's own checks after each group. Use only after the user has reviewed the plan and said to apply it.
argument-hint: "<plan-path> [--auto-only]"
---

# Refactor Apply

Turns a reviewed plan into edits. Never runs unasked; the plan it consumes was
shown to the user first, by `refactor` or by the user invoking an analysis
directly.

## Input

One plan file: an individual `./tmp/simple-refactor-plan-*.md` or
`./tmp/deep-refactor-plan-*.md`, or the orchestrator's
`./tmp/refactor-merged-*.md`. All three share the same shape - Critical /
Warning / Info sections, each item with `file:line`, a fix, and an
`Auto-fixable: Yes/No` flag.

## Process

### 1. Read the plan and the repo's checks

Parse every item. Then find what "passing" means in this repository - its
lint, typecheck, and test commands from `package.json`, `Makefile`, `CLAUDE.md`
or `AGENTS.md`. Run them once before touching anything so a pre-existing
failure is not mistaken for one you caused.

### 2. Auto-fixable first

Apply every `Auto-fixable: Yes` item, grouped by file. Rules:

- Change only the lines the finding names and what the fix strictly requires.
  A refactor pass does not widen a PR's scope.
- Never alter behaviour to satisfy a convention; if a fix would, it is not
  auto-fixable - move it to manual and say why.
- After the group, run the repo's checks. Fix straightforward failures you
  introduced; revert an item you cannot make pass and report it.

`--auto-only` stops here with a summary.

### 3. Manual, one at a time with the user

For each `Auto-fixable: No` item, in plan priority order - Critical first:
state the finding, the proposed change, and any judgment call it needs; wait
for the user's answer; apply; run the checks. The user may skip any item; a
skipped Critical is recorded, not argued.

### 4. Report

```
Applied: X auto-fixable, Y manual (Z skipped by user)
Checks: [each command] PASS/FAIL
Reverted: [items that could not pass, with reason]
Left for follow-up: [skipped or out-of-scope items]
```

Do not commit. The user (or `prepare-pr`) owns the commit, and the diff should
be reviewable as its own step.

## Rules

- No blanket rewrites; every edit traces to a plan item.
- Behaviour-preserving only. If a change would alter behaviour, it needs the
  user's explicit yes and a test.
- Pre-existing debt marked "not against this PR" is not applied unless the
  user asks for it by name.
- Secrets, credentials, and generated files are stop conditions.
