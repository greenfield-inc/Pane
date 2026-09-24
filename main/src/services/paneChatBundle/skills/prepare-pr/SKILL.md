---
name: prepare-pr
description: Prepare a branch for review by committing scoped changes, rebasing on main, running builds, and creating or updating a pull request. Use when the user wants the branch ready for PR review. Also use for rewriting an existing PR description from its current diff and evidence.
---

# Prepare PR

This is a high-trust workflow. Surface any destructive or ambiguous step before proceeding.

## Detect and rewrite an existing PR

On invocation, resolve any supplied PR URL or query the current branch for an existing PR. If one exists, default to rewriting its description unless the user explicitly requests code/branch preparation; read the existing title/body, current diff, source ticket/discussion and available review/QA/check evidence; use the writing contract and [reference](references/writing-guide.md) to rewrite the requested narrative and refresh its Grain companion when connected. Preserve valid closing lines, relevant human context and honest tested-SHA/QA/publication limits; the request authorizes rewriting the requested prose. This mode runs only writing, visual/evidence verification and persisted-body readback: leave code, commits, branch history, labels and draft/ready state unchanged, and do not rerun application QA solely for an editorial rewrite. Report the description update separately from the PR's current readiness. Use the full workflow below when preparing code for review.

Workflow:
1. Group current changes into logical commits, ideally by done-plan.
2. Create focused commits without staging unrelated work.
3. Fetch and rebase onto `origin/main`.
4. Resolve obvious conflicts directly. Ask the user about semantic conflicts.
5. Run the relevant build steps and fix straightforward failures.
6. Create a visual PR diagram before opening/updating the PR:
   - Use the [excalidraw-pr-diagrams](../excalidraw-pr-diagrams/SKILL.md) skill.
   - Keep all generated diagram working files under `/tmp`, usually `/tmp/codex-pr-diagrams/<branch-or-pr>/`.
   - Add a `## Visual Overview` section to the PR body.
   - Include explicit `Before` and `After` diagrams in the visual overview.
   - Use the rendered Excalidraw image as the primary visual. Add Mermaid only when the user requests a text-rendered fallback.
   - Reuse a repository-owned long-lived release such as `pr-assets`, and follow the diagram skill's unique naming, collision, manifest, and metadata/direct-content verification rules. Creating that release is a separate hard stop requiring an exact grant such as `{"action":"create_release","repo":"owner/name","tag":"pr-assets"}`; generic GitHub, PR, comment, or asset-upload authorization does not grant it. Otherwise prepare the exact commands and marked Markdown and report the blocker.
7. Audit existing PR body/comment image references. Replace dead, expiring, temporary, or local-only URLs with verified durable assets. Update agent-owned marked sections in place, preserve author text outside them, and change only a broken URL when it sits in author-owned prose.
8. Push the branch. Use `--force-with-lease` only when the rebase made it necessary.
9. Create or update the PR with a summary built from the plans, current diff, and a visual overview bounded by `<!-- pr-visual-overview:start -->` / `<!-- pr-visual-overview:end -->` that embeds the verified image inline. Read the PR back and confirm it is non-draft when the requested outcome is a ready PR.
10. Run the [cold-read](../cold-read/SKILL.md) skill on the PR title and body and apply its improvements before reporting done. Human review has not been requested yet, so its creative freedom applies in full.
11. Size the PR with `git diff origin/main...HEAD --numstat`, counting hand-written files and lines only (exclude lockfiles, generated and vendored files). If it exceeds 10 files or 300 lines, end the report with one line offering `refactor` (the blind simple + deep pass that merges once and stops before applying). Under that size say nothing. Offer, never run; use the bundled skill through the parent's configured native roles only when the user requests it.

Rules:
- Before drafting, read [references/writing-guide.md](references/writing-guide.md) for the completed example and fidelity check; when Grain is connected, adapt its bundled visual template.
- Write for a zero-context junior SWE: lead with the source discussion/ticket's motivation and intended outcome, then introduce core concepts and explain the diff in dependency order; flag missing rationale rather than inventing it.
- Cover every changed area, why it changes, tradeoffs, validation and limitations; use ample concrete before/after examples and diagrams, regardless of Grain availability.
- When Grain is connected, save and visually verify a rich version of the final PR body with section navigation, rendered diagrams and hyperlinks to code/evidence; the PR must remain understandable without opening Grain.
- When Grain is available, use `grain` to discover/reuse the repository-and-PR (or branch) workspace, creating one if absent; store diagrams, QA media and reports there and link verified evidence in a self-contained PR, overriding release uploads and inline-asset requirements.
- When that Grain workspace exists and the `session-trace` skill is installed, attach this session's trace to it and link it from the PR companion.
- Extend the linked intent brief with the final PR explanation, before/after behavior, and verified results; retain intent and decision history.
- New workspaces default to `Development Artifacts/<org>/<repo>`; explicit destinations win. Clarify ambiguity, name for the task/PR, verify organization/folder/audience, and return the location. Preserve local and tracker/evidence contracts.
- Never use blanket staging.
- Treat secrets and credentials as stop conditions.
- Keep build-fix commits separate when they are distinct from the feature work.
- If GitHub CLI or network access is unavailable, report exactly where the flow stopped.
