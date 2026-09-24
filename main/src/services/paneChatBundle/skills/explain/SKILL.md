---
name: explain
description: Use when the person wants to understand a concept or how something works today. Never plans.
---

# Explain

Finish when the person could teach it back. Ideas for what to build belong in [`options`](../options/SKILL.md).

## Inline first

Answer small questions in the conversation. Offer an HTML explainer only when the concept is big enough that the person would want to come back to it or share it, or when they ask for one.

## Gather facts before teaching

Read the code yourself for small questions. For a larger trace, give a fresh-context subagent one question to answer with the `gather-evidence` skill, for example "how does a message travel from the API to the provider, with file references". Give the subagent just that question, and interpret what comes back yourself.

## The explainer

Render it with the [`page`](../page/SKILL.md) house standard. Save it under `explainers/` in the work's bundle and add it to the brief's "Related" list. With no brief yet, it gets a bundle of its own.

Sections, in order:

1. Title and a one-paragraph gist
2. How it works now, told as a story
3. One concrete walkthrough: a real request or record from start to finish
4. Diagrams: data flow, states, or sequence, whichever carries the idea
5. Glossary
6. Common misconceptions
7. What this is not, and what has not been decided
8. Still fuzzy: questions the explainer could not settle

End with next moves as questions only, never as actions:

- Want this turned into a brief?
- Want options?
- Is this actually a bug?

## Banned

- Implementation steps, file lists of changes to make, or "next we will implement"
- Recommending a design. If the person asks what to do, that is the `options` skill.
- Editing code

## When an explanation changes things

If what the person learns changes the live options, update the options document and its "What we learned" section. If it changes the problem itself, update the brief and tell them you did.
