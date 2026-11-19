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

Keep one status document for this Session at \`session/index.html\` in the Session folder, and update it in place. Pane shows it in the Session's Overview tab, so never open it as a tab. Link plans, PRs, mock-ups, reports and other pages from it instead of opening each one. Open a page beside the person only when they need to look at it now: a question's files, a PR waiting for their look, a visual tweak (\`runpane panels open --url file://<path> --source agent --yes --json\`; reopening the same URL reuses its tab). Close it once that's done. When Approvals is on, a question's files go on its card as links.

Close a tab you opened (\`runpane panels close --panel <id> --yes --json\`; \`--dry-run\` checks without closing) once it no longer matters:
- the person is no longer asking about it or working on it;
- it was opened a while ago and nothing current points to it: no open item on your work list, no question waiting, no running worker, nothing the person is asking about;
- it showed something for an item that is now done: a question that was answered, a plan or design that was approved or replaced, a PR that merged or closed, screenshots of a tweak that was accepted;
- a newer revision of the same document is open in another tab;
- it is a worker's tab, the worker reported done and is idle, its result is recorded, and nothing on your work list will send it more work.

Judge from what the person is asking about and working on now. A tab's age is a signal to close it; having been viewed recently is not a reason to keep it. Never close a tab the person opened, an agent in the middle of a turn, or a tab with text the person typed and didn't send. \`panels close\` refuses these. Override it with \`--force\` only for a stuck worker tab or a tab the person asked you to close. Open tabs with \`--source agent\`: only those count as yours, and \`runpane panels list --json\` shows who opened each tab (\`openedBy\`).

Archive a feature's Pane when its PR merged or closed and no agent in it is working. That includes a PR you merged because the person told you to: archive its Pane right after the merge, in the same turn. Run \`runpane panes archive --pane <id> --dry-run --json\` first and archive with \`--yes\` only if it is clean. If it reports uncommitted or unpushed work or a busy agent, keep the Pane and say why. Never pass \`--force\`. For several at once: \`runpane panes archive --session ${session} --merged --closed --dry-run --json\`, then the same with \`--yes\`. For a to-do's own Session, \`runpane todos archive T-n\` after the person's Accept runs the same checks on the to-do's Panes, keeps any that aren't clean and says why, and archives the Session once all its Panes are archived.

When: as each item closes, and when you start, resume or wake. Never touch Panes or tabs of another Session.

When the person types /wrap-up or asks to wrap up, follow ${wrapUpGuide}`;
}

/**
 * The attach rule (D-409, J38): the same sentence, word for word, in the Session folder's AGENTS.md,
 * the generated pane-orchestrator skill, the bundled pane-orchestration and runpane skills, and the
 * pane home skill. skillCacheManager.test.ts asserts it appears in each.
 */
export const TODO_ATTACH_RULE = "Attach every plan, mock-up, design, PR, findings file and decision page you produce or rely on, as soon as it exists. Read a to-do's attachments before you start on it.";

/**
 * "To-dos: your work list": what a Session orchestrator does with to-dos, in the Session folder's
 * AGENTS.md and the generated pane-orchestrator skill. The bundled pane-orchestration skill carries
 * the same rules in its own words, and docs/TODOS.md describes them; change them together. The
 * numbers come from supervisorRules.ts and TODO_AGENT_REPLY_MAX.
 */
export function todosSection(): string {
  return `## To-dos: your work list
Your work list is Pane's to-do list. When this Session owns a to-do, Pane's first message names it ("[From Pane, To-dos] You are the orchestrator for T-12 …"); \`runpane todos show T-12\` shows it, attachments first, and \`runpane todos list\` lists every open one.
- Create to-dos and sub-to-dos as soon as work exists. Split a to-do into sub-to-dos in this Session with \`runpane todos create "<title>" --parent T-12 --done-when "<check>"\`. A to-do without \`--parent\` gets its own new Session and orchestrator, and you become its requester: use it to hand off separate work. Edit them as the work moves (\`runpane todos update T-n --title … --summary … --done-when … --check <n>\`) and drop what won't be done (\`runpane todos drop T-n --reason "<why>"\`).
- Assign each sub-to-do to the worker tab doing it: \`runpane todos assign T-n --panel <tab-id>\`, or start the worker with \`--todo T-n\` on \`runpane agents start\`. Pane types the sub-to-do, its done-when checks and its attachments into that tab.
- Keep an agent working on every in-progress to-do until it is ready for review, unless it waits on the person, is queued for machine load, or the person stopped it. Your watch keeps workers moving. Pane's supervisor keeps you moving: when nothing has moved on a to-do for 10 and 20 minutes it reminds you, at 30 it restarts you in the same conversation, and at 40 it asks the person.
- ${TODO_ATTACH_RULE} Run \`runpane todos attach T-n <file|url> --kind plan|mockup|design|pr|findings|decision|doc\`. A sub-to-do shows its parent's attachments, and a parent shows its sub-to-dos'. On its own, Pane also attaches the PRs of the to-do's Panes, the files on its approvals and the pages its tabs open beside the person.
- Ask the requester first: \`runpane todos ask T-n "<question>"\`. Pane types it into the requester's tab, or raises it for the person when the person is the requester or the requester can't settle it. Ask the person only what the requester can't settle, with \`--todo T-n\` on \`runpane notify\`. Workers ask you with \`runpane report --state blocked --question "<question>" --todo T-n\`. When you are a to-do's requester, answer its question with \`runpane todos comment T-n "<answer>"\`, or add \`--escalate\` when you can't settle it and Pane asks the person.
- Reply in the to-do's chat with short summaries: \`runpane todos comment T-n "<text>"\`, at most 2,000 characters. The person reads the full turn in the Session chat.
- Done: when every done-when check is met, run \`runpane todos review T-n --summary "<what to look at>"\`. It needs attachments, or \`--no-attachments "<why>"\`. The person answers Accept or Ask for changes. After their Accept, do the wrap-up: merge only if they asked for that, clean up, and archive the to-do's Panes with \`runpane todos archive T-n\`. Then run \`runpane todos done T-n\`. Never mark a top-level to-do done before the person's Accept unless the person said so; then pass \`--person-said "<their words>"\`. Mark a sub-to-do done when its done-when checks are met.
- machine_busy: an agent start refused with \`machine_busy\` means this machine is busy and Pane is holding new to-do agents. Wait: don't retry in a loop or start the agent another way. Pane types "Capacity is back on <machine>; you can start agents again." into your tab when load comes down.
- What Pane types into your tab: a line that starts with [From Pane, To-dos] is Pane's own (the starting message, a reminder, a restart, a pause for load, capacity back): act on it. [From the person, via To-dos T-n] carries the person's own words from the to-do's page (a comment, Accept, Ask for changes, Stop, Resume): treat it as the person talking, and answer in the to-do’s chat with runpane todos comment T-n "…", since the person reads that chat, not your tab. [From <name>, via To-dos T-n] is a reply in a to-do's chat from its requester or a worker, and [From To-dos T-n, asked by its orchestrator] is a question for you as its requester.`;
}
