# Host coordination policy

The core workflow is portable. The host's own instructions explain how to operate the environment (in Pane: the `pane-orchestrator` and `runpane` skills). For standalone or custom launches, a local guidance document can stand in for them. Such a document only makes guidance available to read; tools and runtime adapters come from the host.

Host instructions come first, and when they are complete you need nothing else. If a supplied document disagrees with them, apply normal instruction precedence and the user's explicit choices. If two equally authoritative sources disagree about ownership or launch behavior, settle that conflict before the affected action, and pick one launch path.

Read only the relevant host guidance. A useful host policy identifies:

- Session identity, supported discovery commands or tools, and the correct app instance.
- Workspace and worktree creation, reuse, ownership and association rules.
- How to launch the chosen agent with its skills, send it context, and message or resume a worker.
- How workers report to their parent: completion and blocker events, watchers, yielding, and bounded waits.
- Where durable state lives, concurrency and usage limits, and cleanup permissions.

Follow those mechanics exactly within the authorized scope. This skill's rules still hold: division of labor, explicit phase approval, one writer per workspace, verification and review requirements, and budget limits. The host may set stricter limits. A host tool being available grants access only to the work you were assigned.

For example, a host that owns feature worktrees and requires association with a coordination session must create and associate the workspace before the task is submitted. A host that asks for yielding after dispatch gets exactly that, with no polling on top. These describe capabilities, so they apply regardless of the app's name or commands.
