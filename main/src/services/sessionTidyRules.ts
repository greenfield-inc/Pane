/**
 * "Keep the Session tidy": the cleanup rules every Session orchestrator gets,
 * in the Session folder's AGENTS.md and in the generated pane-orchestrator
 * skill. The bundled pane-orchestration skill carries the same rules in its own
 * words; change them together. Kept as its own section so other instruction
 * changes don't have to edit it.
 *
 * `session` is how the archive sweep names this Session; `wrapUpGuide` is the
 * absolute path of the /wrap-up guide the orchestrator can read.
 */
export function keepSessionTidySection(session: string, wrapUpGuide: string): string {
  return `## Keep the Session tidy
Clean up as you go, without asking. In your next message, say in one line what you closed or archived. Tidying this way is already authorized; it is not a hard stop.

Keep one status document for this Session, in the Session folder, and update it in place. Open it beside the person when you first write it (\`runpane panels open --url file://<path> --source agent --yes --json\`) and reopen the same URL after each material update; it is the one tab you keep open. Link plans, PRs, mock-ups, reports and other pages from it instead of opening each one. Reopening the same URL reuses its tab. Open a page beside the person only when they need to look at it now: a question's files, a PR waiting for their look, a visual tweak. Close it once that's done. When Approvals is on, a question's files go on its card as links.

Close a tab you opened (\`runpane panels close --panel <id> --yes --json\`; \`--dry-run\` checks without closing) once it no longer matters:
- the person is no longer asking about it or working on it;
- it was opened a while ago and nothing current points to it: no open item on your work list, no question waiting, no running worker, nothing the person is asking about;
- it showed something for an item that is now done: a question that was answered, a plan or design that was approved or replaced, a PR that merged or closed, screenshots of a tweak that was accepted;
- a newer revision of the same document is open in another tab;
- it is a worker's tab, the worker reported done and is idle, its result is recorded, and nothing on your work list will send it more work.

Judge from what the person is asking about and working on now. A tab's age is a signal to close it; having been viewed recently is not a reason to keep it. Keep the status document open until /wrap-up. Never close a tab the person opened, an agent in the middle of a turn, or a tab with text the person typed and didn't send. \`panels close\` refuses these; never override it. Open tabs with \`--source agent\`: only those count as yours, and \`runpane panels list --json\` shows who opened each tab (\`openedBy\`).

Archive a feature's Pane when its PR merged or closed and no agent in it is working. That includes a PR you merged because the person told you to: archive its Pane right after the merge, in the same turn. Run \`runpane panes archive --pane <id> --dry-run --json\` first and archive with \`--yes\` only if it is clean. If it reports uncommitted or unpushed work or a busy agent, keep the Pane and say why. Never pass \`--force\`. For several at once: \`runpane panes archive --session ${session} --merged --closed --dry-run --json\`, then the same with \`--yes\`.

When: as each item closes, and when you start, resume or wake. Never touch Panes or tabs of another Session.

When the person types /wrap-up or asks to wrap up, follow ${wrapUpGuide}`;
}
