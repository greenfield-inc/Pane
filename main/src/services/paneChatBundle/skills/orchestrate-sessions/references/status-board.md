# Session status page

One HTML page per Session for the person: the workstream map. You fill a status JSON from the Session's real state, and the renderer beside this skill draws the page from it. Never write the page's HTML by hand.

## Write it

```sh
node <this skill's directory>/assets/status-page/render.mjs <Session folder>/.agent/status.json <Session folder>/session/index.html
```

- When `node` is not on PATH, run the same script with Pane's own runtime, as the runtime context file says.
- Write the page to `<Session folder>/session/index.html`. Pane shows that file in the Session's Overview tab, so never open it with `runpane panels open`. Outside a Pane Session, open it once with `runpane panels open --url file://<absolute path>` and reopen the same URL after each rewrite.
- Write it at the first dispatch, again at each material change (a worker report, a decision, a PR opened, reviewed or merged) and when the person asks. Each rewrite replaces the same file.
- The page carries `<meta http-equiv="refresh" content="60">`, so the Overview tab reloads it every minute.
- The page is self-contained: no script, no network, diagrams drawn at render time, and Inter embedded as a font subset, the one exception to `page`'s system fonts. One item in flight renders at about 90 KB and each further one adds about 12 KB, so the page passes `page`'s 200 KB at about 10 items in flight. Keep finished items in `done`, where each takes one line.
- The renderer needs only Node: rough.js and the font are vendored beside it, with their licenses. `assets/status-page/example-status.json` is a filled example showing every state.

## The status JSON

Every fact comes from the Session's real state: the ledger, the workers' reports and status files, `runpane sessions overview` and GitHub. Write "unknown" rather than guess. Say each fact once: a rail, a question row and a `next` line never repeat each other. The renderer escapes every field, except that `next` and `settings` keep `<b>`, `<code>` and `<a href="…">` links.

```json
{
  "session": {
    "title": "the Session's name, as a short human title",
    "eyebrow": "Updated 14:40 · 2 h 05 min elapsed",
    "counts": { "running": 0, "queued": 0, "done": 0 },
    "settings": "one line: review policy (any override, who gave it and when); links allowed",
    "flow": {
      "caption": "Goal: one line",
      "steps": [ { "label": "short", "state": "done | now | need | blocked | todo", "tag": "optional, e.g. NOW · IMPLEMENTATION" } ]
    }
  },
  "needs": [
    { "id": "Q-3 | F-2 | null", "item": "item name", "role": "Planning | Implementation | Review | Orchestrator",
      "blocks": "what waits on it", "q": "the question, one sentence",
      "options": [ { "label": "short", "rec": true }, { "label": "short" } ],
      "why": "one or two sentences", "age": "4 min",
      "link": "pane://open?pane=<pane id>&panel=<panel id>, only for a question asked through Notify",
      "files": "optional link to the page to read" }
  ],
  "items": [
    { "name": "item name", "link": "its front page", "pr": "#1234", "prLink": "https://github.com/…",
      "pane": "Pane name", "paneLink": "pane://open?pane=<pane id>",
      "state": "now | need | blocked | failed | done", "stateLabel": "short",
      "next": "one sentence: who does what next; <b> and <code> allowed",
      "rail": [ { "label": "1-2 words", "state": "done | retried | now | need | blocked | failed | todo | skipped" } ] }
  ],
  "done": [ { "label": "#1234 what it did", "link": "its front page", "detail": "merged 13:02 · no issues hit" } ],
  "decisions": [
    { "id": "D-4", "item": "item", "answer": "the answer, one line", "by": "You | Planning | Orchestrator",
      "q": "the question asked", "options": ["option", "option"], "chosen": "exactly one of options",
      "note": "optional one line", "when": "13:10", "ref": "where it came from, e.g. Q-1 from the plan" }
  ],
  "sources": [ { "label": "Plan (rev 2)", "link": "https://… | a relative path inside the Session folder", "note": "optional, e.g. approved, D-10", "group": "Plan and decisions" } ],
  "links": [ { "label": "PR #1251 walkthrough", "link": "https://…", "note": "optional", "group": "Pane #1251" } ]
}
```

Keep the JSON at `<Session folder>/.agent/status.json` and update it in place, so each rewrite starts from the last one.

**Session.** `eyebrow` is the local time of the newest evidence you read and the time elapsed since the Session started, with no cost. `counts` are workers running now, items waiting to start, and items finished. Give `flow` when items depend on each other or run in sequence: one step per item or wave, in the order of work. The page shows it only with 2 or more items in flight.

**Needs you.** One entry per open question, approval or finding waiting on the person, newest blocking first; `[]` when there are none.

- A worker's question asked through Notify (its card is live): `id` is `null`, since it is numbered once answered, and `link` is `pane://open?pane=<pane id>&panel=<panel id>`, the item's Pane id and the asking worker's panel id from the ledger. The person clicks it to open that tab with its card docked.
- A question you relay yourself: its Q-n and no `link`, since the person answers it in your conversation. Link its files in `files`.
- Review findings waiting on the person: the F-n, with no `link`.

**Items.** One per work item still in flight, in the order of work. `link` is its front page: its brief when it has a bundle, otherwise its hub ([item-hub.md](item-hub.md)). `paneLink` opens its Pane. `state` is `need` when it waits on the person, `blocked` or `failed` when a worker is stuck; the state bar counts those, and `next` says what is missing or the failure in one line.

The rail is the path the work actually took, then what is still ahead: one dot per real step (Plan, Plan rev 2, Approved, Build, CI, Fix 1, CI again, QA, Review, Fix F-1–F-3, Follow-up review, Merge). A past failure that was retried is `retried`; the current step is `now`, `need`, `blocked` or `failed`; steps still ahead are `todo`. Keep labels to 1 or 2 words and rails to about 10 dots.

`next` carries what the rail cannot show, such as unreviewed commits: "N commits since the last review at <sha>, not reviewed", counted with `git rev-list --count <last reviewed head>..<PR head>`, or "never reviewed" when there is no reviewed head. The last reviewed head is the ledger's `last_reviewed_head` for that PR; when the ledger has lost it, use the head the newest review on the PR covered, and record it.

**Done.** Every completed item (PR merged or closed, plan abandoned), newest first, linking its front page, with its outcome and "no issues hit" or that a post-mortem exists. An item moves here and is never removed.

**Decisions.** Every D-n, newest first, from the ledger's `decisions`.

**Sources and links.** The page is the one place that points to everything the person may need to see. Add every artifact a worker produces or relies on as soon as it appears, and keep it after the work is done. `sources` are the documents behind the work: plans and tickets, briefs, options and decision pages, mockups, review findings, QA records and traces. `links` are everything else worth opening: PRs, each PR's companion page, reviews, Panes, dashboards and external references. Take them from the workers' reports and status files, the bundles' pages, the findings files and the briefs you wrote. Link files inside the Session folder by their path relative to `session/` (`../plans/brief.html`, `items/fix.html`), and files elsewhere on this machine as `file:///…` URLs. Group entries by kind of work with `group`: in `sources`, "Plan and decisions", "Design", "Reviews", "QA" and one group per follow-up; in `links`, one group per PR named by repository and number (for example "Pane #1251"), then "Examples" or "Other". Groups show in the order they first appear, and an entry without one falls under "Other". The page omits a section whose array is empty. A `link` with a scheme other than `http`, `https`, `file` or `pane` becomes `#`. Write every relative link with a `/` in it (`./report.md#sec`, `../work/findings.md`), because a bare file name with `#`, `?`, `%` or a space in it can become `#`.

The cleanup log and the end-of-run summary live in the ledger and your final report, not on the page.

Link only pages that exist, and check each local link after rendering.
