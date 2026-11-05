---
name: refactor
description: Quality pass on a branch against its remote default branch. Runs a simple analysis (conventions and smells) and, on large changes, a deep one (correctness defects) as blind, independent subagents, merges them once, stops for the person, then applies the approved plan and has an adversary try to break it. Use after a PR is open, or when asked to refactor, clean up or quality-check a branch. Modes - simple, deep, apply - can also run alone.
argument-hint: "[simple|deep|apply <plan>] [--base=<ref>] [--size=small|large] [--plan-only]"
---

# Refactor

Run with no mode for the full pass: size, analyse, merge, stop, apply, prove. It changes the head, so run it before QA when QA evidence must match the head.

## 1. Size the change

Compare against the merge-base with `--base` when given (a stacked PR's base branch), otherwise the branch's remote default branch, resolved from the branch or PR (`git remote show <remote>`) and fetched fresh. When the base is ambiguous, report that and stop.

```bash
MB=$(git merge-base "$BASE" HEAD)
git diff "$MB" --numstat            # merge-base to working tree: includes uncommitted work
git ls-files --others --exclude-standard   # untracked files count as added
```

Count hand-written lines only; name the lockfiles, generated and vendored files you leave out. **Small** is up to 10 files and up to 300 lines; exceeding either makes it **large** (`--size` overrides). If the branch is behind the base, say "rebase before merge" once; it isn't a finding.

## 2. Analyse, blind

Each analysis runs in its own fresh subagent with the base, the file list and this skill, and never sees another analysis. Analyses only read: each writes its one plan file to a path the parent names, and runs no builds, installs or new worktrees. Independent runs overlap on about half their findings, and the severe ones often come from one alone, so one run per mode is the rule.

- **small:** simple only. **large:** simple and deep at once.
- For a requested comprehensive review, add focused deep runs with one lens each, in waves within capacity: reuse, clarity, scope, repo anti-patterns, competing patterns, backend architecture, frontend architecture, documentation, circular imports, module boundaries, query/cache behaviour. Use only lenses that fit the stack.

**Both modes first learn this repository's conventions:** read `CLAUDE.md`/`AGENTS.md` at the root and in every touched directory, then two or three neighbouring files the maintainers treat as done. Before calling something a violation, `grep` how many files already do it; what the codebase does everywhere is the convention. Count only lines this branch adds or changes; list pre-existing debt under Info as "pre-existing, not against this PR" (`git blame` settles it). When the branch makes an old flaw worse, grade the new consequence.

**simple** checks the changed lines for: long functions (over ~100 lines) or nesting over 3 levels, magic values, missing or swallowed error handling on new paths, unused code, commented-out code, TODOs without context, duplicate logic that one function with options would cover, and repo rules the conventions step found (imports, layering, state, error types, tests, file comments where neighbours have them), each cited to the file that states it.

**deep** runs simple's checks per layer, as the repository names them, and adds:
- **Correctness in every new or changed path** (do this first on huge diffs): unguarded I/O (spawn, write, socket, stream: early exit, EPIPE, timeout, partial handshake); guards enforced at one entry point but not others reaching the same operation; lifecycle (timers, listeners, in-flight work, process trees stopped); stale state when its key changes; platform and path assumptions; new logic with no test where neighbours have one, naming the case that would catch it. Each finding states the concrete failure chain and is reproduced where cheap. Critical: a reproduced failure that loses data, breaks a flow or a security boundary. Warning: a real defect with less impact, or a plausible one, with the repro it needs.
- **Cross-cutting:** one purpose per unit; one source of truth per type; similar functions, hooks or services that differ only by configuration become one with options.
- A convention row with no clear local rule is "unestablished", never invented.

**Auto-fixable** means a mechanical edit that keeps behaviour: renames, wording, dead code, imports, a test-only cleanup. New tests and logic changes are manual.

Each writes its plan, returns the path, and edits nothing:

```markdown
# <Simple|Deep> refactor plan
Size, type, layers · base <sha> to working tree · conventions from <files>
### Critical
- [S1] file:line - what's wrong. Failure: <chain>, reproduced yes/no (correctness items). Fix: <how>. Rule: <file that states it, or "universal", or "correctness">. Auto-fixable: yes/no
### Warning
- ...
### Info
- ... (and pre-existing items)
Auto-fixable: N · Manual: M (pre-existing items not counted)
```

Number items per plan (`S1`, `D1`) so the person can approve them by name.

An empty Critical section is a normal result for a clean change.

## 3. Merge once

Write `./tmp/refactor-merged-<timestamp>.md` in the same shape: cluster findings about the same issue in the same place, keep the highest severity and any reproduction, keep sole-source findings, tag each with its source (`[S]`, `[D]`, or the lens), and mark an item manual when the plans disagree on auto-fixable. Give the merged counts.

## 4. Stop for the person

Run `cold-read` on the merged report and apply what it finds to ordering, titles and clarity, keeping findings, severities and `file:line`. Show Criticals in full, summarise the rest with auto-fixable and manual counts, and wait for the person's go. `--plan-only` ends here. Standalone simple or deep runs also stop here and offer `apply`.

## 5. Apply (mode `apply <plan>`)

1. Find the repo's own lint, typecheck and test commands, limited to what the change touches (end-to-end specs only for touched flows, any server on a spare port), and run them once before editing, so existing failures stay separate. To compare with the original, read it with `git show <sha>:<path>` or check it out in a separate clone; keep the stash and `checkout` out of it, since worktrees share them.
2. Apply every auto-fixable item, grouped by file, changing only what the finding names. A fix that would change behaviour moves to manual. Run the checks after each group; revert an item you can't make pass and report it.
3. Take manual items one at a time with the person, Critical first: state the finding and change, wait, apply, check. A skipped item is recorded.
4. Commit the edits as one scoped commit named for the plan, so the adversary has an exact diff.

## 6. Prove it, in one chain (at most three review passes)

1. **Pass 1:** a fresh subagent reads only the apply commit's diff and tries to prove it broke something: every claim in the apply report is falsifiable, behaviour-preserving changes must preserve behaviour, consolidations must keep every edge case callers relied on. A test claiming to fix a defect must fail on the parent and pass on the head. It returns CLEAN, or REGRESSION with `file:line` and a repro.
2. **On REGRESSION:** the applier repairs and commits with the repro as a test proven failing on its parent. Then, together: the reviewer who found it re-runs its repro in its own session to close the finding, and a new fresh subagent reads only the repair's diff to break the repair. That fresh read is the next pass.
3. **Before pass 3**, make the repair spec-driven (a test table of the input class, or a pure derivation), and stop rather than widen scope. Whatever pass 3 finds goes to the person.

Run the chain without waiting between passes and report at the end: what was applied, each pass's result, open Criticals, and the checks. Then re-run the analyses once (fresh subagents) and show the delta as three lists: closed, remaining, new. New Warnings or Criticals go to the person as follow-ups; applying them needs another go.
