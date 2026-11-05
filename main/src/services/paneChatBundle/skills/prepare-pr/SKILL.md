---
name: prepare-pr
description: Prepare a branch for review by committing scoped changes, rebasing on main, running builds, and creating or updating a pull request. Use when the user wants the branch ready for PR review. Also use for rewriting an existing PR description from its current diff and evidence.
---

# Prepare PR

This is a high-trust workflow. Surface any destructive or ambiguous step before proceeding.

## Detect and rewrite an existing PR

On invocation, resolve any supplied PR URL or query the current branch for an existing PR. If one exists, default to rewriting its description unless the user explicitly requests code/branch preparation; read the existing title/body, current diff, source ticket/discussion and available review/QA/check evidence; use the writing contract and [reference](references/writing-guide.md) to rewrite the requested narrative and refresh its published companion page when one exists. Preserve valid closing lines, relevant human context and honest tested-SHA/QA/publication limits, and say in the checks or limits line what has run (for example "CI, QA and review not yet run"); the request authorizes rewriting the requested prose. This mode runs only writing, visual/evidence verification and persisted-body readback: leave code, commits, branch history, labels and draft/ready state unchanged, and do not rerun application QA solely for an editorial rewrite. Report the description update separately from the PR's current readiness. Use the full workflow below when preparing code for review.

Every PR, however small, gets the diagram image and its own artifact (steps 6 and 9, and the companion-page rules below). Match the rest of the effort to the change: a docs-only or few-line PR gets a one-region diagram and a short companion page, skips steps 7 and 10, and keeps the body short.

Workflow:
1. Group current changes into logical commits, ideally by done-plan.
2. Create focused commits without staging unrelated work.
3. Fetch and rebase onto `origin/main`.
4. Resolve obvious conflicts directly. Ask the user about semantic conflicts.
5. Run the relevant build steps and fix straightforward failures.
6. Create a visual PR diagram before opening/updating the PR, for every PR:
   - Draw it with the [excalidraw-pr-diagrams](../excalidraw-pr-diagrams/SKILL.md) skill: explicit `Before` and `After` paths in a `## Visual Overview` section, one region for a small PR.
   - Render it to PNG, upload it to the repository's `pr-assets` release and verify it, as that skill's Publishing on a PR says. When the renderer cannot run, a Mermaid diagram takes the image's place and the body says the image was not rendered.
7. Audit existing PR body/comment image references. Replace dead, expiring, temporary, or local-only URLs with verified durable assets. Update agent-owned marked sections in place, preserve author text outside them, and change only a broken URL when it sits in author-owned prose.
8. Push the branch. Use `--force-with-lease` only when the rebase made it necessary.
9. Create or update the PR. Its body opens with a short summary built from the plans and current diff; right under the summary comes the visual overview bounded by `<!-- pr-visual-overview:start -->` / `<!-- pr-visual-overview:end -->`, embedding the verified image inline, then one line linking the PR's own artifact (below) with a `<!-- pr-artifact: <url> -->` marker; then links to the brief, plan and issue when they exist, and the rest of the body. Read the PR back and confirm it is non-draft when the requested outcome is a ready PR.
10. Run the [cold-read](../cold-read/SKILL.md) skill on the PR title and body and apply its improvements before reporting done. Human review has not been requested yet, so its creative freedom applies in full.
11. Size the PR with `git diff origin/main...HEAD --numstat`, counting hand-written files and lines only (exclude lockfiles, generated and vendored files). If it exceeds 10 files or 300 lines, end the report with one line offering a [refactor](../refactor/SKILL.md) pass (blind simple and deep analyses, merged once, applied only on the person's approval, and run before QA because it changes the head). Under that size say nothing. Offer, never run.

Rules:
- Before drafting, read [references/writing-guide.md](references/writing-guide.md) for the completed example and fidelity check, and build the companion page from its walkthrough template, published or local.
- Write for a zero-context junior SWE: lead with the source discussion/ticket's motivation and intended outcome, then introduce core concepts and explain the diff in dependency order; flag missing rationale rather than inventing it.
- Cover every changed area, why it changes, tradeoffs, validation and limitations; use ample concrete before/after examples and diagrams, whether or not a document destination is named.
- Every PR has one artifact of its own: the companion page, a rich version of the final PR body with section navigation, rendered diagrams and hyperlinks to code/evidence, visually verified. It holds the diagram image, QA media, reports made for the PR and, later, the post-mortem. The PR must remain understandable without opening it.
- When your workspace instructions name a document destination, the companion page is the repository-and-PR (or branch) page there. Discover it before creating anything (search the destination for the repository and PR number, and read the `<!-- pr-artifact: <url> -->` marker in the PR body), reuse it on every later push, and create it only when none exists: never a second one for the same PR. The pr-assets release still hosts the PR body's image; the companion page holds a copy with everything else.
- When no destination is usable, keep a local companion folder with the same contents outside the repository's tracked files (for example under a git-ignored `tmp/`), open its `index.html` for the person with `runpane panels open --file <path> --source agent --yes`, and say in the PR body: "Material for this PR is kept locally by its author." Print no personal path.
- Under an orchestrator, record where the PR's artifact is in your status file's `pr_artifact`: its URL, or the local companion folder's absolute path. The status file is private, so the path belongs there and not in the PR body; the orchestrator writes the post-mortem into that same artifact.
- When that companion page exists, published or local, and the `session-trace` skill is installed, attach this session's trace to it and link it from the PR companion.
- Extend the linked intent brief with the final PR explanation, before/after behavior, and verified results; retain intent and decision history.
- New pages go to the folder your workspace instructions name; explicit destinations win. Clarify ambiguity, name for the task/PR, verify organization/folder/audience, and return the location. Preserve local and tracker/evidence contracts.
- Never use blanket staging.
- Treat secrets and credentials as stop conditions.
- Keep build-fix commits separate when they are distinct from the feature work.
- If GitHub CLI or network access is unavailable, report exactly where the flow stopped.
