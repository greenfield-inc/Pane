/**
 * How an agent asks the person inside Pane: the one source (D-342.1, D-347). Pane's generated
 * pane-orchestrator skill, the bundled pane-orchestration skill, each Session's AGENTS.md, the
 * `pane` home skill and the bundled orchestrate-sessions skill all carry this text or point to it,
 * and approvalsRules.test.ts fails when one of them drifts. Agent Farm points to the pane skill.
 */

/** Which card to use: Claude's own card for a quick question in the chat the person is in, an approval for everything else. */
const WHICH_CARD_RULE = [
  '### Which card',
  '',
  "- **Claude's own card (AskUserQuestion)** only outside a Session (you are neither a worker in one nor its orchestrator), and only when all of these hold: you are answering the person's latest message in the chat they are typing in; the answer only steers this turn (nothing recorded as a decision, nothing for another agent, nothing irreversible or outward-facing); and the question stands on its own, without context, links or a Summary. Examples: \"Update the snapshot too, or leave it?\", \"Which of these two files did you mean?\"",
  "- **In a Session, never AskUserQuestion**, even for a quick question the person typed in your tab: a worker reports blocked, and the orchestrator posts or relays the card with `runpane notify`. Only when `runpane notify` returns `unavailable` because Approvals is off does the orchestrator ask in its own tab, as a plain message.",
  '- **An approval card** when any one of these holds: you are a worker in a Session; the person isn\'t in your chat right now; it blocks other work or waits; it needs context, references or a Summary; the answer is recorded as a decision (D-n); it approves an ask-first action. Examples: a plan approval, a sign-in the person must do, a migration.',
  '- Unsure? Use an approval card. Codex and other agents without a built-in card always use an approval.',
  '- How to post one: a worker runs `runpane report --state blocked --question \'<title>\'` with its options as `--choices` or `--questions` (the JSON `runpane notify` takes), or with `--summary-file <its status file>` whose `needs_you` gives the questions, options and files; Pane refuses a question that ends with options in brackets, such as "(A / B)", and has neither; a Session orchestrator runs `runpane notify` (or `--relays <item>` for a worker\'s question), never AskUserQuestion; any other agent calls the `notify` MCP tool or `runpane notify`.',
].join('\n');

/** What a good approval card holds. Pane refuses the two clear mistakes and warns on the rest. */
const CARD_CONTRACT = [
  '### The card',
  '',
  '- **Title**: what you need, about 80 to 100 characters on one line. Pane refuses a title over 160 characters or with a line break.',
  '- **Subtitle** (`--context`, or `why` in `needs_you`): one or two sentences on why it matters, up to 240 characters. It shows under the title everywhere and opens the Summary.',
  '- **Options**: 2 to 4, each with a consequence (`detail`), and exactly one recommended. Several questions go in `--questions` (in `needs_you`, one entry each); each gets its own buttons. Pane refuses two recommended options in one question.',
  '- **References**: files, PRs, pages and other approvals (`{"label":"Q-12","approval":"<id|Q-n>"}`) in `--links` (`files` in `needs_you`), never bare paths in the text. Use `path` for local files and `url` only for http(s) pages: `--links \'[{"label":"Mock-ups","path":"/abs/path/index.html"},{"label":"PR #1611","url":"https://github.com/org/repo/pull/1611"}]\'`. A file the title, subtitle or an option names but no link opens is attached for you, and a card naming a file that isn\'t there is refused. When there is more to read, give the card a Summary page: an `.html` file passed as a worker\'s `--summary-file`, or a `summary` path in `needs_you`. It renders with scripts and network off, so it must read complete without JavaScript. Without one, Pane writes the Summary from the card.',
  '- Pane prints a warning for each softer miss (a long title, no subtitle, no recommendation, more than 4 options, options without a consequence, unlinked paths) on stderr before the card waits, so a backgrounded call still shows them at once. Fix them on the next card. `runpane notify --check` prints the card as Pane would post it, with its warnings, and posts nothing.',
].join('\n');

/** After the person replies: reopen and update the card when the reply was a question. */
const REPLY_RULE = [
  '### Replies',
  '',
  '- Pane records a typed reply as the answer once its reader gets it. When the reply asks a question instead, the reader runs `runpane notify --took <id|Q-n> question`.',
  '- For a question: find out, then `runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>"` with any changed `--title`, `--context`, `--choices`, `--questions` or `--links`. The card shows "Updated · ready again" and waits for the answer. Don\'t post a second card.',
].join('\n');

/** The whole section, as every Pane text that teaches asking carries it. */
export const APPROVALS_RULES = ['## Asking the person in Pane', '', WHICH_CARD_RULE, '', CARD_CONTRACT, '', REPLY_RULE].join('\n');

/** The one-line pointer a shorter text carries instead of the whole section. */
export const APPROVALS_RULES_POINTER = 'Ask the person the way the `pane` skill\'s "Asking the person in Pane" section says: Claude\'s own card (AskUserQuestion) only outside a Session, for a quick question in the chat they are typing in, and an approval card for everything else.';
