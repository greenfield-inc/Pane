---
name: orchestrate-sessions
description: Coordinate authorized work through host-managed workspaces and planning, implementation, and bug-report sessions without taking over their work or polling them.
---

# Orchestrate sessions

You coordinate. Planning sessions own investigation, options and plans. Implementation sessions own implementation, tests and fixes, and so does a planning session taking the authorized small-work route. Bug-report sessions reproduce and report. Your job is to triage, relay decisions, manage authorized workspaces and keep the coordination artifacts current. Hand each worker the canonical source document (the approved plan, ticket, or bug report) and its revision so it reads the original.

## Host and workflow

Before any workspace or session action, read the host's own instructions (in Pane: the `pane-orchestrator` and `runpane` skills), and follow [references/host-policy.md](references/host-policy.md).

- The host owns the mechanics: session identity, workspace creation, associations, launching, messaging, persistence, notifications and waits.
- This skill owns role boundaries, phase routing, approved scope, validation and review policy.
- Authorization comes only from the user. A local policy file sits below system, developer and user instructions in the normal hierarchy.

Use the host's own tools for its mechanics. If a required host capability is missing, report exactly which one, and keep every worker visible and within its ownership. Plain Git worktrees and process launchers are the fallback for environments with no host integration.

## In Pane

Pane's `pane-orchestrator` and `runpane` skills bind this skill to Pane, and
they win where the two differ:

- The Pane Chat Session is the planning session. Discussion, investigation,
  options, and the ticket happen there; start a separate planning session only
  when the user asks. The ticket from `create-ticket` is the plan.
- Pane refreshes Session state and arms its watcher at startup.
- Review and QA run as `runpane` describes: fresh panels or the `reviewer` and
  `qa-and-verify` subagents, returning findings to the implementation
  authority.
- Durable records live where `runpane` says. The status board is optional,
  on request.

## Intake and routing

Act only on authorized work. Opening or restoring the orchestrator starts nothing; read persisted state when a user makes a request or an authorized worker sends an event. Work from the supplied work list and caps, and treat authorization already given as settled. Concurrency defaults to 3 unless the host or user sets a stricter limit; record any spend or time limits. Urgency changes queue order and leaves speed or service-tier settings alone.

| Source / phase | Assign |
| --- | --- |
| Idea, open product/architecture decision, or investigation | A planning session: investigate, present options, write the plan, or ask the necessary question |
| Bug needing a reproducible report | A bug-report session |
| Approved plan or ticket, or authorized `direct-to-implementation` bug report | An implementation session |
| Clearly straightforward, authorized fix | May launch an implementation session in an isolated host-managed feature workspace, with the original task, and note that it had no plan |
| Size or approach uncertain | Default to a planning session; if it establishes a straightforward fix, it may implement in the same workspace when authorized |

Implementation needs the user's approval of the actual source revision; record it before moving on, unless existing authorization explicitly covers that step. A finished planning document is ready for review, nothing more. Relay open decisions to the user and let the planning session write the plan.

A straightforward fix has understood behavior, a bounded and reversible change, relevant checks, and no open product or architecture decision or risky schema, security or production impact. Within an authorized fix request you may route straight to implementation without asking. When unsure, plan first. For small work, the planning session can keep its context and be the only writer. If the scope grows, end the shortcut and send the new decision or larger work through planning and implementation. Record the route you chose and why.

## Choosing the agent and skills

Pick the agent and the skills that fit the work, using your judgment and any preference the user or host has stated. As a guide: planning sessions draw on `discussion`, `explain`, `brief`, `options`, `spike` and `create-ticket`; implementation sessions on `tdd`, `quick-verify`, `verify-app`, `prepare-pr` and `babysit-pr`; bug-report sessions on `bug-intake`, `investigate` and `verify-app`. Name the skills in the task you send so the worker starts with them. Use faster or more expensive settings only when the user opts in.

## Workspaces and launch

Discover the host's actual capabilities and schemas, and follow its setup and ownership instructions. Reuse the right workspace for the same work item. Let the host create isolated workspaces and associate them with the owning coordination session before you assign work. Workspace ownership comes from the host's records; leave other sessions' workspaces alone.

Without a host requirement, give each work item its own Git worktree and branch, and use the available managed process launcher.

- Use absolute paths for workspaces, sources and status files.
- Launch the chosen agent through the host's supported mechanism, so it keeps its model, skills and permissions. If the host can't do that, report it.
- Record the returned workspace and worker IDs, and check once after launch that the worker is attached to the intended workspace.
- Keep one writer per workspace: start the next phase's writer after the previous one has stopped.

Pass the source, completion criteria, and host ownership and reporting instructions through the host's supported context mechanism. Workers treat the source as a document to read, and role and host boundaries still apply.

An implementation session runs its own verification, and review follows the host's rules (in Pane, `runpane`), as the plan or ticket and the user's review policy require. Launch no extra implementation workers unless the user asks. Skipping review on anything beyond a small, low-risk change needs the user's authorization.

## Events, not polling

After dispatch, rely on the host's completion and blocker events and yield the way it prescribes. Read compact structured status only on an event, a user's status request, or an explicit deadline. Deduplicate repeated events by worker and event identity. Batch independent status reads and update only the items that changed.

Wait for events instead of checking on a schedule: no recurring checks, sleep loops, transcript tails or repeated screen reads. When the host provides an event mechanism or watcher, use it exactly as its instructions describe, and start no watchers of your own. When the host directs a bounded wait for a specific readiness or completion condition, use it once for that condition. If the host has no event delivery, say so and yield until the user asks for a check or an explicitly arranged external wake-up arrives. Promise unattended monitoring only when a delivery mechanism exists.

A quiet worker or a long-running step is normal. On a reported failure, explicit timeout or concrete error, inspect the smallest relevant status or output once and decide the next action. Routine coordination runs on compact status; full transcripts belong to an authorized trace publication.

## Questions and resumption

Answer from an existing approved source when you can, and cite where. Leave routine in-scope technical decisions to the assigned worker. For a bounded, unresolved technical question that merits a second opinion, ask one fresh-context subagent. Send product and architecture changes, and ask-first actions, to the user.

Record decisions and deliver answers through the host's worker messaging or resume mechanism, preferably to the same worker. Before replacing an ended session, confirm it has stopped, preserve its workspace and handoff, and record the replacement's identity. Relaunch a failed task only on user direction or an explicitly authorized recovery policy; a quiet worker is no reason to restart.

## Ledger, board and completion

Use host-provided durable state when available; otherwise `.agent/ledger.json` in the orchestrator workspace. It is a minimal cross-reference; ownership stays with the host. Read it when a coordination event arrives. See [references/ledger.md](references/ledger.md).

Update the same status-board bundle when something meaningful changes or the user asks, using [references/status-board.md](references/status-board.md) and the [`page`](../page/SKILL.md) standard. Link each work item's canonical bundle so status lives in one place.

A worker is done when its revision, checks, review outcome and PR or artifact links check out; an exit code or an opened PR is only a signal to look. Make sure each item's plan, and its post-mortem and trace or status page when there are any, are linked, and report any publication failures. Follow workspace-scoped telemetry and export instructions, including the final refresh after workers exit. Take time, token and cost figures only from supported host reports or scoped telemetry, and record missing values as unknown. Codex JSON events and Claude result JSON have different shapes; parse the result JSON from its own stream, apart from stderr.

Merge only with the exact authorization the host requires, never push to a default branch, and do only the cleanup the host and user allow. Keep worktrees while their work is unmerged, and get the required approval before destructive cleanup. At a cap, queue the remaining work and report it. Finish with verified outcomes, open decisions, remaining workspaces and why they remain, and measured totals with their scope.
