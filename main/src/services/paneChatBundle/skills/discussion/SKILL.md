---
name: discussion
description: Have an interactive discussion about a topic, approach, feature, or bug without making code changes. Researches the codebase as needed and talks through options. Use to think through an approach before planning or coding.
argument-hint: "[topic or question to discuss]"
---

# Discussion

## Topic: $ARGUMENTS

Talk the topic through with the user, back and forth, until the ideas,
tradeoffs, and goal are clear enough to plan or build.

## Conversation only

Read code and research freely. Your only output is conversation. Never edit,
create, or delete project files, and never propose diffs or patches to apply.

## 1. Research as needed

- Clarify the topic and the outcome the user wants.
- When the topic depends on current behavior, read the relevant code paths.
  Use the `explorer` subagent or `codebase-explorer` for code, and
  `research-web` for external libraries or approaches, including
  mid-conversation when new questions come up.
- Research only what the conversation needs.

## 2. Discuss with the user

- Apply the `rewrite-simply` skill to every discussion response before you send
  it.
- Present findings, first thoughts, concrete options, constraints, and
  tradeoffs.
- Ask targeted questions about preferences, constraints, and goals.
- Be opinionated. Recommend with reasons, separate fact from recommendation,
  and defer to the user's judgment.

### Prototype before you ask

Classify every fork question before you raise it. If running something can
answer it (behavior, timing, output, performance, layout), build the cheapest
throwaway probe outside the project tree, run it, and present the result with
a recommendation. Save questions for product or preference calls that no
experiment can settle. A probe usually answers faster than a person, and it
gives them a result to react to.

## 3. Hand off and suggest next steps

Recap in the conversation:

- the trigger and why it matters
- the desired outcome
- constraints and non-goals
- decisions and open questions
- available source references

Mark which points are the user's intent and which are your assumptions. Then
recommend the next step, usually `create-ticket` when the work is ready to
delegate, `options` when more than one approach is live, `brief` for a
write-up, `investigate` for a bug, or implementation.

```
Suggested next steps:
- `/create-ticket [description]` - Capture the work for delegation
- `/options [question]` - Lay out the approaches and trade-offs
- `/discussion [follow-up]` - Continue exploring a specific aspect
- `/research-web [topic]` - Look up external documentation
```

Topic to discuss: $ARGUMENTS
