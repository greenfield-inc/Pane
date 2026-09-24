---
name: options
description: Use when the person asks what to do or for trade-offs, or more than one design is live. Waits for a pick. Never plans.
---

# Options

This is the only place alternatives are argued. If the implementation session could still choose the architecture, this step was skipped.

## Rules

- One section per decision. Small decisions can be asked inline and recorded later in the plan (the ticket from `create-ticket`, or `plan.html`) instead of getting a document.
- Two or three real options per decision, plus two that are always present: the **smallest version** (what ships if everything deferrable is deferred, and what the user loses) and **do nothing** (what stays wrong, observably).
- State each option's complexity-ladder rung, and give a reason for every rung above the lowest workable one. The ladder: 1 configuration or copy, 2 reuse an existing pattern, 3 new code inside one module, 4 a new contract between modules, 5 a schema change or migration, 6 a new dependency or new infrastructure.
- Give every option, including the smallest version and doing nothing, a short complexity statement as described in the template. Cover both the requirements and the implementation: the complexity added compared with today, the likely ways it breaks, and the ongoing maintenance or operating cost. Say which requirements drive that cost, what could be simplified or deferred, and what the user would lose. Back claims with repository evidence where you have it, label assumptions, and describe effort and risk in words rather than scores or probabilities.
- Recommend one option and say what the person must accept if they take it.
- A decision blocked on a missing fact becomes a [`spike`](../spike/SKILL.md) or a question answered with the `research-web` skill.
- Revise the document in place as the person learns. Record why options changed under "What we learned".

## Socrates

When the person says they are ready to pick, send the brief and this document once to a fresh-context Socrates reviewer, briefed as in [create-ticket's Socrates reference](../create-ticket/references/socrates.md), with repository access. Also ask it to argue for less (what can be deferred, which schema changes, dependencies, or infrastructure can be avoided, whether the smallest version is really the smallest) and to challenge every ladder rung that lacks a stated reason. Relay its material questions. Record its verdict (pass, clarify, or rethink) against the revision it reviewed. Continue the same Socrates agent through follow-ups, two rounds at most. Socrates investigates facts and asks questions. The person settles product choices. Skip Socrates for small decisions.

## Output

An HTML page for the person, laid out as in [references/options-template.md](references/options-template.md) and rendered with the [`page`](../page/SKILL.md) house standard. Save it as `options.html` in the work's bundle. End with the status line and wait.

## Banned

- Implementation steps, file-level changes, task breakdowns
- Picking on the person's behalf
- Starting the plan before there is an explicit pick
