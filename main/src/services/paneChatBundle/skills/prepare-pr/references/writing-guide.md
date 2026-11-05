# A PR that teaches the change

Read this before drafting a PR. The reader has the diff and this body, but no chat, private plan, or document-destination access. Use the structure and level of explanation below; replace every example fact with evidence from the current task. Scale length to the mechanism, not the number of files. A one-line copy fix needs less exposition than a change with alternate paths.

## Build the explanation

Choose the explanation and visuals that make the underlying idea easiest to understand. Build from first principles, keep useful detail, and let the subject determine the format, in both the PR and its companion page.

Possible examples, not required formats:

- For a retry change, show what happens when an attempt fails, how it recovers, and what the person sees.
- For a permissions change, show who can see or change something, and why that boundary exists.
- For a performance change, show where the wait comes from and how the change reduces it before introducing implementation details.

1. Extract the trigger, affected person, intended outcome, constraints/non-goals and decisions from the ticket/discussion. Keep source links or stable artifact references. Separate user decisions, implementation choices and unresolved rationale.
2. List every changed area privately and give it a place in the explanation. Group by behavior and dependency; do not narrate the order you edited files.
3. Introduce unfamiliar entities before using them. Explain the before/after mechanism and why this approach satisfies the intended outcome. Include a concrete input/output example, an important boundary or failure path, and a diagram when it clarifies relationships. Follow the skill's visual-publication rules.
4. State tests and QA separately with their actual commits and scopes. Old QA may support unchanged behavior but cannot prove a later fix. Distinguish passing, failing, skipped, blocked and untested. Never fill a template with assumed passes or invented links. State unavailable evidence/publication in the PR prose itself, not only in hidden comments or the chat handoff.
5. Read the body as a new teammate: can they explain why the change exists, how every diff area contributes, the important alternate paths, and the limits of the proof without opening another artifact?

## Adaptable spine

- **Why this change exists:** source motivation, affected user, outcome and relevant non-goals.
- **Concepts and approach:** entities, relationships, old behavior, chosen mechanism and tradeoffs.
- **Behavior and diff walkthrough:** cover all changed areas in dependency order with concrete examples and relevant diagrams.
- **Validation and limitations:** checks/QA, tested commits, remaining uncertainty and specific follow-up verification.
- **Supporting evidence:** named, verified links; essential explanation stays above.

Respect repository-required sections and tracker closing lines. These headings are a writing scaffold, not a requirement to repeat the same facts under several names.

## Completed fictional example

The following example illustrates exposition, not reusable product facts, test results, or publication URLs.

### Why this change exists

Support reports that accountants reconcile every refund by hand because the exported ledger shows refunds as positive sales (discussion record D-17). The requested outcome is a complete CSV with signed refund amounts. Omitting refunds was rejected because accountants need the full ledger. This change affects export presentation only; saved invoices and normal sale rows retain their behavior.

### Concepts and approach

A transaction stores a `kind` and an amount in integer cents. The CSV presents that amount as a decimal string. A refund is money returned, so its exported amount must be negative. Missing data is different from a real zero: an unknown amount exports as an empty cell.

Previously, the exporter divided every amount by 100 without inspecting its kind. It now checks for a missing amount first, then normalizes refunds to a negative magnitude and formats the result. Taking the absolute magnitude before negation also handles refunds already stored with a negative sign.

```text
Transaction → amount missing? → yes: empty CSV cell
                    ↓ no
                refund? → yes: negative magnitude → decimal string
                    ↓ no
              existing sale amount → decimal string
```

### Behavior and diff walkthrough

| Changed area | Before → after | Why it matters |
| --- | --- | --- |
| Export mapping | A refund of 1,250 cents produced `12.50`; it now produces `-12.50`. A refund stored as -1,250 cents also produces `-12.50`. | Correct sign without double-negating existing negative values. |
| Missing-amount handling | A missing amount could appear as a numeric value; it now produces an empty cell. | Preserves the distinction between missing data and a genuine zero. |
| Export-panel help | Generic download text now explains negative refunds and empty cells. | Users can interpret the output before sharing it. |
| Regression cases | Tests cover normal sales, both refund-sign inputs and missing amounts. | The suite checks the transformation and its important alternatives. |

A normal sale of 1,250 cents still exports as `12.50`. Export-only normalization avoids rewriting historical records, at the cost of leaving the original storage conventions intact. Other consumers of those records are outside this change.

### Validation and limitations

The four regression cases and required CI passed on commit `b222222` in this fictional record. Browser QA exercised the help text and download on `a111111`, before the missing-value fix. It supports those observed UI behaviors but does not prove the final blank-cell path. That path needs a final-commit download check. Import into the accountant's spreadsheet was not tested.

### Supporting evidence

The supplied screenshot and recording exist locally, but the fixture provides no successful publication record. Report publication as unavailable until verified; do not turn local paths into upload claims. A usable release-asset path remains available when no document destination is named.

## When the why is missing

If the ticket says only “make refunds negative,” write: “The requested behavior is signed refund exports; the originating motivation was not supplied.” Carry the gap forward, ask when it materially affects the approach, and do not invent an accountant request, revenue impact, or compliance driver. The completed example above is not evidence about the current task.

## Companion page

Link the PR description to its companion page and the page back to the PR; verify both links are clickable, including private or unshared pages, and preserve access settings.

Every companion page, published or kept locally, starts from the [bundled walkthrough template](../assets/pr-walkthrough.html) and follows the `page` skill's house standard. Replace its slots with the **published final PR body**, converted to semantic HTML; preserve every explanatory section, example and limitation. Put the PR's visual overview in the drawing slot right under the summary; that image is the page's opening drawing for `page`'s Draw first rule. Render other diagrams as self-contained SVG or locally saved rendered images, keeping descriptive text or source as a fallback. Add named code and evidence links. Put QA visuals under Validation and limitations after a plain-language takeaway, and link detailed reports. Preserve the PR's explanation even without a companion page.

The template carries `page`'s colours, one-column layout and components: status chip, panels, before/after pairs, call-outs and `details`. Fill `TITLE`, `SUMMARY`, `STATUS_HTML`, `PR_URL`, `SOURCE_SHA`, `DIAGRAM_HTML`, `CONTENTS_HTML` (a list of links to each `h2`), `BODY_HTML` and `EVIDENCE_HTML`; escape text and attribute values, and insert only trusted generated HTML into the `_HTML` slots. Do not publish unfilled slots. Wrap each table in `<div class="table-wrap">` so a wide one scrolls on a phone. Keep an exact copy of the final Markdown as `pr-body.md` beside the page and verify it matches the persisted PR body. Check the page against `page`'s Before you share it list, and verify screenshots, links and diagrams in the saved page. A saved layout or sample screenshot does not prove the current app passed QA. When your workspace instructions name a document destination, publish there and follow its rules for publication and audience authorization; otherwise keep the page in the local companion folder. A companion folder holds `index.html`, `pr-body.md` and `evidence/`; it is the PR's artifact, not a `page` bundle, so it needs no `bundle.json`.

## Refreshing an older PR

`prepare-pr` automatically uses this guide when the supplied URL or current branch has an existing PR; `rewrite <PR URL>` is also accepted. Full code/branch preparation for an existing PR requires an explicit request. Recover the motivating discussion/ticket and preserve its source links; retain accurate evidence and explain any missing rationale. Replace stale descriptions of abandoned approaches with the final mechanism, while preserving relevant human context and closing lines. A better explanation does not upgrade old tests to the latest SHA or turn missing QA into a pass. Refresh the visual companion from the persisted rewritten body when one exists, keeping the page its `pr-artifact` marker names; when you cannot reach that page, keep the marker and say the page was not refreshed. Reuse the visual overview when the diff still matches it, and redraw it when the change moved. Run `cold-read` on the rewritten body as for a new PR. Report an editorial update without claiming the underlying PR is ready.
