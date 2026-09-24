# Preserve intent at ticket handoff

- Use **Intent**, **Scope**, and **Acceptance Criteria**; add **Inputs Needed**, **Starting Points**, and **Decision History** where useful.
- Preserve the user's language and constraints. Ground requirements in sources; distinguish facts, decisions, proposals, and open questions.
- Capture the trigger, expected/actual behavior, and consequence, or the unmet need for a new idea. Attribute reports; label suspected causes and unmeasured impact.

## Complete source

Fictional source D-17: “Accountants reconcile every refund manually because our CSV shows it as a positive sale. Keep all rows; show refunds as negative amounts. Limit this to exports; preserve saved invoices. Missing amounts should be blank.”

- **Intent:** Accountants should receive a complete ledger they can reconcile directly.
- **Scope:** Export refund amounts with the correct sign and explain the convention in export help. Preserve every row, normal sales, and saved invoices.
- **Acceptance criteria:** A 1,250-cent refund exports as `-12.50`, including when its stored sign is already negative; a normal sale exports as `12.50`; a missing amount exports as an empty cell.
- **Sources:** D-17. Use a link when available; an identifiable discussion reference is useful when the source has no shareable URL.

## Evolving intent

Fictional follow-up D-18: “The finance team imports these into a tool that expects separate sale and refund columns. Use that format instead, and keep both amounts positive. The goal is still reconciliation.”

- **Current what:** Export separate sale and refund columns with positive amounts.
- **Current why/outcome:** Finance can import a complete ledger into its tool and reconcile it directly.
- **Preserved constraints:** Retain every row, preserve saved invoices, and keep missing amounts blank.
- **Updated acceptance criteria:** A 1,250-cent refund appears as `12.50` in the refund column; a normal sale appears in the sale column; missing amounts stay blank.
- **Inputs Needed:** Confirm how to represent the other column. A blank cell is a proposed convention, pending confirmation.
- **Decision history:** D-17 requested signed amounts. D-18 supersedes that format because the receiving tool expects separate columns. The reconciliation goal remains current.
- **Handoff:** Update the existing issue and the same Grain brief, replacing superseded acceptance criteria and retaining this short history.

Apply this treatment when the motivation or intended outcome changes too: label the earlier goal as superseded, cite the new decision, and refresh scope and success criteria.

## Incomplete source

Source: “Make refund exports negative.”

- **Known what:** Export refunds as negative amounts.
- **Inputs Needed:** What problem prompted this, who is affected, and what would successful use look like? Clarify the unanswered decisions that affect scope.
- **Evidence boundary:** The accountant story, saved-invoice constraint, and empty-cell rule belong to D-17. Requirements for this new request come from its own sources.

## Observation before solution

Fictional source D-19: “I changed one sentence, clicked Save, and saw the whole document in the request. Add patches to cut editing costs.”

- Check the editing path, existing options, and actual cost before choosing guidance, investigation, or patches.

## One or several outcomes

For “capture this discussion in Grain,” save the brief there. For “give support the copy change and engineering the export fix,” create separate delegation artifacts with their own outcomes and link the shared rationale. Choose ticket-only, Grain-only, or combined delivery from the request.

## Refine with the human

- Ask: “What happened last time?”, “What would a good result enable?”, “What would make the existing approach sufficient?” Investigate facts; let the user settle product choices.
- Show the proposed experience, alternatives, and tradeoffs with a useful example or mockup. Label uncertainty and fidelity limits; leave implementation steps to planning.

## Explain enough to delegate

Lead with the real-world problem and the desired result. A before/after example, simple flow, or decision timeline can help when it explains a meaningful relationship. Let the subject determine the format.

Keep each artifact usable on its own. When GitHub and Grain are both used, keep the same intent, scope, acceptance criteria, and material decision changes available in both for readers with different access.

### Include the approved mockup

- Offer `ui-mockup` for UI changes; a direct request accepts the offer. Continue ticket work if declined or unavailable, noting any relevant visual gap.
- In Grain, place a **Design reference** beside the proposed experience, before detailed acceptance criteria. Save the image in the same workspace with its caption, version/approval status, final prompt, and source references.
- In GitHub or another tracker, place **Design reference** after Scope and before Acceptance Criteria. Embed a verified, durable attachment matching the audience, or link the existing authorized artifact. Use private Grain URLs as brief links; retain local files until upload succeeds.
- Describe the approved behavior in text, align it with the image, and treat incidental generated details as illustrations. Identify the selected version and earlier drafts. Follow these placement principles in other destinations.
