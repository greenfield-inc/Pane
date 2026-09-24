---
name: spike
description: Use only when a decision is blocked on a fact nobody has. One time-boxed question, one answer.
---

# Spike

A spike answers one question so a decision can be made. Write one only when a decision is actually blocked on it.

## Steps

1. Write the question so the answer is a fact, not an opinion. "Can the queue delay a job by 24 hours without a new table?" is a spike. "What is the best queue design?" is an options question.
2. Set a time box and a method. Throwaway code is allowed and expected.
3. If the question is answerable from the web or docs, answer it with the `research-web` skill. If it needs the repo or a running system, give a fresh-context subagent the question to answer with the `gather-evidence` skill. Give the subagent the question and the time box only.
4. Record the answer and the evidence.
5. Feed the answer back into the options document under "What we learned". Re-rank the options if it changes them.

## Format

Plain text in the page bundle (see `page`), for example `spikes/{slug}.md`:

```
# Spike: {one question}
Blocks: {which decision and options}
Time box:
Method:
Throwaway allowed: yes

## Done when
An answer, not a feature.

## Answer
## Evidence
Feeds back to: {options link}
```

## Banned

- Merging spike code into the real plan automatically. If spike code should ship, it goes through the plan like any other change.
- Widening the question after starting
