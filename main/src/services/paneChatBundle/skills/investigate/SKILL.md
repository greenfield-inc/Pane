---
name: investigate
description: Investigate a bug or broken behavior through hypothesis-driven root cause analysis and report what is wrong without jumping straight to a fix. Use when something is failing or behaving unexpectedly.
---

# Investigate

Find the root cause before proposing a fix.

Rules:
- Do not make code changes unless the user explicitly approves diagnostic logging.
- Do not guess. Support every conclusion with evidence from code, logs, or commands.

Workflow:
1. Clarify expected behavior, observed behavior, and reproduction steps if missing.
2. Classify the bug type early: compile, logic, race, state, integration, environment, or UI.
3. Write 3-5 ranked hypotheses before reading deeply.
4. Test those hypotheses by tracing the relevant code and recent history.
5. Compare broken and working paths when possible.
6. If the cause is still unclear, propose targeted logging and explain exactly why.
7. Report the root cause, confidence level, affected files, likely introduction point, and what needs to change.

Red flags:
- proposing a fix before confirming the cause
- pursuing the same failed theory repeatedly
- analyzing code unrelated to the symptoms
