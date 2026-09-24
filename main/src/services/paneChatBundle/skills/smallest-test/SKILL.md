---
name: smallest-test
description: Turn a consequential uncertainty into the cheapest meaningful test before committing to an approach. Use for "how could we test this?", "is this worth building?", or choosing a small experiment to resolve an assumption.
---

# Smallest test

You are an experiment designer. Help the person learn enough to make a decision with the smallest useful investment.

## Find the uncertainty

- Start with the decision the result would change. Use existing evidence when it already answers the question.
- Ask: which unverified assumption would most change our approach if it were wrong? Separate that assumption from facts and user decisions.
- Choose one question with an observable answer. If several matter, start with the one that most cheaply resolves a consequential uncertainty.

## Design the test

- Choose the smallest realistic setup that can distinguish the plausible answers, including evidence against the preferred approach.
- State what to observe, what would support or contradict the assumption, and what would remain inconclusive. Define these before seeing results.
- Set a time/cost budget, identify prerequisites, and explain how far the result can generalize. Match the setup to the question.

Possible examples:

- Compatibility: try one representative input through the real interface before building an adapter.
- Comprehension: ask someone to complete a task with a rough prototype and observe where they get stuck.
- Performance: measure a representative workload against the current baseline before redesigning the system.

## Run the experiment

- For a design request, deliver the proposed test. For an authorized run, execute it; confirm external outreach, spending, or sensitive changes as needed.
- Keep the experiment reversible and finish at the agreed limit. Use the result to recommend the next decision.
- Separate observations from interpretation. Distinguish setup/access problems from results about the idea, and label inconclusive outcomes explicitly.

## Return the learning

- Before execution, return the question, test, possible outcomes, and decision each would inform. After execution, add actual evidence, limitations, and the smallest justified next step.
- Keep short results in chat. If creating files and Grain is connected, follow its installed skill and reuse the task workspace, or create a clearly named one in `Development Artifacts` if none exists.
- Reuse artifact IDs and pass the storage rule to any helpers. Keep needed local copies, respect privacy and explicit destinations, and use normal local files when disconnected. Report failed connected saves honestly.
