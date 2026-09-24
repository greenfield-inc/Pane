---
name: brief
description: Use when a problem, idea, or change of intent is worth capturing as a long-form page, or the person asks to write it up. Never chooses a solution; the tracker issue belongs to create-ticket.
---

# Brief

A brief says what is wrong or wanted, for whom, and how a user would know it is solved. It survives a change of approach, because it contains no approach. Alternatives belong in the options document. Steps belong in the plan.

## Capture the intent

- Preserve the person's language and constraints. Ground every statement in a source: the conversation, an issue, a bug report, the code.
- Keep four things visibly apart: facts, decisions already made, proposals, and open questions. Label suspected causes and unmeasured impact as such.
- Capture the trigger: what happened, what was expected, and what it costs. For a new idea, capture the unmet need.
- When the request arrives with a solution attached ("add patches to cut editing costs"), look at the actual behaviour and cost first, and write the problem underneath it.
- Ask what is missing instead of inventing it: what prompted this, who is affected, what a good result would enable, what would make the current approach good enough.
- Read the code, or give a fresh-context subagent one question to answer with the `gather-evidence` skill, when a fact about today's behaviour is needed. Give the subagent just that question.
- Research settles behaviour, never approach. A researched answer about what a user observes goes in as a labelled proposal with its source, pending the person's confirmation; anything about how it is built is only named here and argued in the options document.

## When intent changes

Revise the same brief. Mark the earlier goal as superseded, cite the decision that replaced it, refresh success and constraints, and add a change-log line. Keep constraints that still hold. If what changed is only the approach, the brief does not change: that belongs in the options document.

## One brief or several

Keep one coherent outcome together. Split work that has independent outcomes, owners, or release timing, and link the shared context.

## Layout

An HTML page for a person, rendered with the [`page`](../page/SKILL.md) house standard. Layout: [references/brief-layout.md](references/brief-layout.md). Someone who was not in the conversation should understand the problem in a minute.

## Save and link

Draft freely during discussion. Save or publish only when the person asks or confirms it is ready. Filing an issue does not mean work starts. When you save, follow [references/saving.md](references/saving.md): the bundle first, the tracker issue when they use one, then read back what you saved.

## Ready check

Before calling it ready, read it as the person who will pick it up: can they say what is wrong, why it matters, how success is observed, and which decisions are still open? Set the status chip accordingly. When the person is ready to choose a direction, the brief goes to Socrates review with the options document, as the [`options`](../options/SKILL.md) skill describes.

## Banned

- An architecture or implementation presented as decided
- Acceptance criteria written as implementation steps
- Implementation steps, file lists, or a plan
