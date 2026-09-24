---
name: bug-intake
description: Use when the person reports broken behaviour or starts a session to file a bug. Reproduces and reports. Never fixes.
---

# Bug intake

The goal is a report someone else can act on. The first move is reproduction, not theory.

## Steps

1. Restate the symptom in one sentence and confirm it with the person. Get the environment, the account or record involved, and when it started.
2. Reproduce it.
   - If it needs the running app, reproduce it with the [`verify-app`](../verify-app/SKILL.md) skill, yourself or through a subagent given the steps to attempt, and collect screenshots, console output, and network failures.
   - Otherwise give a fresh-context subagent one question at a time to answer with the [`gather-evidence`](../gather-evidence/SKILL.md) skill: find the failing test, collect logs, trace the code path, list touched files. Give it the question and a fresh context, not this conversation.
3. Interpret the evidence yourself. Classify the failure early: compile, logic, race, state, integration, environment, or interface. Write three to five ranked hypotheses before reading deeply, then test them against the code and its recent history. Compare a broken path with a working one when you can. Drop a theory once the evidence rules it out, and leave choosing the fix to whoever takes the report. If only diagnostic logging would settle it, say exactly what you would add and ask first.
4. Write the success definition: the bug is gone when what is observably true.
5. Choose a route:
   - `direct-to-implementation`: obvious locus, contained change, tests exist. The report can serve as the whole task for an implementation session.
   - `options-first`: unclear locus, or fixing it forces a design choice. It goes to a planning session.
   - `cannot-reproduce`: say what was tried and what evidence would help. Stay in intake.
6. File the report wherever the person tracks work (a GitHub issue, Linear, or another tracker). With no tracker, save it as `index.html` in a bundle of its own in the format at [references/bug-report.md](references/bug-report.md), rendered with the [`page`](../page/SKILL.md) house standard, then stop.

## Banned

- Fixes, patches, "quick" changes, refactors
- Writing a plan
- Presenting a hypothesis as the confirmed cause without evidence

## If the person then says "fix it"

Hand it on. For `direct-to-implementation`, tell them to start an implementation session with the report as its source. For `options-first`, tell them to take the report to a planning session.
