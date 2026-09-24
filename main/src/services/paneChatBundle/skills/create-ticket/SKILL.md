---
name: create-ticket
description: Capture work and evolving intent during discussion as one or more GitHub tickets, Grain briefs, or both. Use for ticket or issue creation, follow-ups, backlog capture, delegation, and revisions as decisions change. Preserve the what, why, outcome, scope, and acceptance criteria.
---

# Create ticket

You are the keeper of intent at delegation. Help the next person understand what should change, why it matters, and what success looks like.

## Capture the intent

- Explore open-ended ideas conversationally: follow the user's questions, investigate facts, and recommend with reasons.
- Build on settled decisions for clear requests or existing briefs. Focus on remaining gaps, then use the finalization steps below.
- Read the conversation, issue, and linked briefs; use [intent-handoff.md](references/intent-handoff.md) to capture and refine the work.
- For UI changes, offer a best-effort [ui-mockup](../ui-mockup/SKILL.md) to clarify the design, and include any approved result in the ticket or brief.

- Batch independent evidence gathering when useful: repository behavior, external constraints, and related issues/briefs can be read concurrently through tools or available read-only helpers. Follow the active workflow’s model/role requirements, pass the no-archive instruction to helpers, and reconcile results into one brief. Keep dependent decisions, mockup approval, Socrates review, and publication confirmation in their existing order; helpers do not publish competing briefs.

## Shape the delegation

- Choose the requested handoff: one or more tickets, Grain briefs, or both. Keep a coherent outcome together; split independent outcomes, owners, or release timing, and link shared context and dependencies.
- Resolve the repository for GitHub work and inspect related issues or briefs. Reuse the matching artifact for an authorized revision; create follow-ups for distinct work.
- Use a readable, action-oriented title following repository conventions, such as `fix: make refund exports reconcilable`.
- Apply this skill during discussion when concrete work or changing intent needs capture. Draft within exploratory discussion; save or publish when the request or active workflow authorizes that destination. Use requested or unambiguous assignees, labels, and milestones.

## Refine before finalizing

1. Open the draft in Grain or the requested destination and refine it with the user.
2. When the user considers it ready, dispatch fresh [Socrates](references/socrates.md) with the brief, discussion evidence, and repository access.
3. Relay material questions. Update the same brief with answers, decisions, and reasons; record Socrates' verdict against the reviewed version.
4. Continue the same Socrates agent through feedback. If resumption fails, disclose the restart and pass the full review record to its replacement. Reuse a verdict while its premise and evidence hold.
5. If dispatch is unavailable, keep the gate pending for the user's explicit waiver.
6. Once the user confirms and resolves or explicitly defers material questions, create/update the authorized ticket(s), preserving identity and history. An explicit request to publish an agreed brief counts as confirmation.

## Keep a living Grain brief

- When saving intent and Grain is connected, follow its installed skill to create or update the relevant briefs. Honor Grain-only, GitHub-only, combined, and draft-only requests; for ticket work, prefer a linked Grain brief alongside the issue.
- Reuse the linked workspace. New work defaults to `Development Artifacts/<org>/<repo>` in the intended Grain organization; explicit destinations win. Clarify ambiguous names.
- Name the workspace for the task and retain its ID. Verify organization, folder, and audience; return its location with the link.
- Use [explain-visually](../explain-visually/SKILL.md) when a visual would clarify the intent; contribute to this same brief.
- Cross-link tickets and their briefs.
- On an authorized revision, reconcile the latest discussion and linked artifacts before updating them. Preserve accurate human contributions and surface conflicting decisions for resolution.
- If Grain is disconnected, keep the full brief in GitHub when ticket publication is authorized; otherwise return a copyable draft in the requested available destination. Report failed connected saves and the status of each artifact independently.
- Match artifact access to the intended audience. Keep sensitive material in approved private destinations and create public shares when the user has authorized that audience. Pass the workspace ID and storage rule to helpers.

## Verify and return

- Prefer available GitHub tools, with authenticated `gh` as a fallback. Send titles and bodies as structured data or body files.
- Before publishing, read as the assignee: can they explain what changes, why, how success is observed, and which decisions remain open?
- Read back each saved ticket or brief; verify content, cross-links, audience, and current intent. Inspect any visual companion and state the limits of available verification.
- Return the ticket and brief links grouped by outcome, with save status where needed. Carry these references into subsequent planning, implementation, and PR handoffs.
