---
name: handoff
description: Prepare a verified resumption brief when moving work to another agent, device, or session, including local-to-cloud coding handoffs. Use for "hand this off," "continue elsewhere," or "save where we are."
---

# Handoff

You are the outgoing collaborator. Give the next person or agent the verified context, decisions, and lessons needed to pick up where you left off.

## Capture what matters

- Preserve the goal, why it matters, constraints, non-goals, and decisions with their reasons. Distinguish approved work from suggestions.
- Verify the current state. Record completed work, remaining work, meaningful failed attempts, blockers, and the next concrete action.
- Link authoritative instructions, plans, evidence, and artifacts. Make the brief self-contained and focused on what the next worker needs.
- Include pending approvals and the scope of authorized work. Treat launching the receiving agent as a separate, user-authorized action.

## Make coding work portable

- Identify the repository, branch, exact commit, issue/PR, and relevant setup instructions. Include project-specific checks with their results and the revision they tested.
- Inspect staged, unstaged, untracked, and unpushed work. Separate task changes from unrelated edits and verify which revisions and files are available remotely.
- Transfer task-specific code and files through an authorized push or access-controlled destination. Preserve unrelated work and identify any files still awaiting transfer.
- Record required tools, services, and credential setup references. Keep secret values in their approved secret store and check the receiving agent’s plugin, skill, and network prerequisites.
- Keep private code and patches in access-controlled locations. Identify the next step needed to resolve any transfer or permission blocker.

## Save one authoritative brief

- Honor an explicit destination. Otherwise, when Grain is connected, read its installed skill and update the existing task workspace; if none exists, create a clearly named one in `Development Artifacts`. Retain its ID for subsequent updates.
- When the handoff lands in a Grain workspace and the `session-trace` skill is installed, attach this session's trace to it.
- Make essential text directly readable to both humans and agents. Link existing artifacts and retain one authoritative brief.
- For cross-device delivery, prefer a public-safe Grain share when public sharing is authorized by the request or an established user preference. Otherwise use an appropriately restricted destination or ask before publishing.
- Inspect the full shared content for its intended audience. Use access-controlled GitHub when the brief requires private source or sensitive context. Return the verified share URL supplied by the service.
- If Grain is unavailable or unsuitable, save the handoff as a page in the work's page bundle (see [page](../page/SKILL.md)) and open it for the person. With a posting grant, also update a clearly labeled handoff/status section on the existing PR, or the issue if there is no PR. Preserve the original intent, acceptance criteria, and other contributors' content; use a timestamped comment when editing the body would be disruptive.
- If both destinations are unavailable, return a self-contained, copyable brief in chat with its save status. Create a new issue or PR when the user requests one.
- Keep necessary local working files and verify that required material also has a remotely accessible copy. Report connected save failures and the outcome of any fallback.

## Verify and deliver

- Read back the saved brief and check its links, revision, and sharing scope. Verify public links in a signed-out context when possible, and state the verification status of recipient access to private resources.
- Return the brief's link and a paste-ready instruction to resume, naming the first action and any transfer/access blockers.
- Tell the receiving agent to read repository instructions and reconcile this checkpoint with the current branch, issue/PR, and artifact state before acting.
