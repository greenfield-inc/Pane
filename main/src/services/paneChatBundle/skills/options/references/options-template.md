# Options template

Lay the HTML page out in this order. Keep each option scannable: a short paragraph and a small table beat long prose.

```
Options: {feature}
Source: {brief or bug report link}
Status: waiting on pick | Picked: {option}, by {who}, {date}

Decision 1: {what must be decided}
  Kind                      product | technical   (product: users see it, or the
                            system acts on a user's behalf)

  Option A: {name}
    What it is
    Optimizes               speed | risk | consistency | usage
    Gives up
    Risk and reversibility
    Complexity ladder rung        1 configuration .. 6 new infrastructure, with the reason
    What users experience   the functional difference, including failure states
    Complexity statement    added complexity, bug risk, ongoing maintenance
    Prior art               what leading apps do for the same behaviour,
                            verified (source) | unverified
    Requirement trade-offs  which requirements drive the cost, a simpler scope, and the value lost
    Migration cost
    How we would verify

  Option B ...
  Option C ...

  Smallest version          always present: what ships if we defer everything
                            deferrable, and what the user loses
  Do nothing                always present: what stays wrong, observably

  Recommendation
  What you accept if you take it
  Blocking unknowns         each becomes a spike or a research question, or "none"

Decision 2 ...

Socrates verdict            pass | clarify | rethink, and which revision it reviewed
What we learned             from explainers and spikes, and why the options changed
Change log                  newest first
```

## Complexity statements support the choice

For each option, give two to four plain-language sentences comparing it with the current codebase. The complexity ladder identifies the kind of change; the statement explains its consequences. Cover both **what the feature promises** and **how we build it**:

- **Added complexity:** systems reused or extended, and any new state, interactions, contracts, schema, dependencies, or operational machinery. Say so when an option removes complexity or adds little.
- **Bug and maintenance risk:** the likely failure modes and future burden that matter for this decision, such as keeping two representations in sync, handling permission combinations, supporting older data, retries, or running another service. Separate the one-time build effort from the recurring cost.
- **Requirement trade-offs:** the behavior or requirement causing the burden, and a realistic simplification or deferral that would reduce it, with what the user loses or gains. Weakening an agreed requirement is the person's decision, so present it as a choice.

Labels such as low, moderate, or high are fine when a concrete explanation follows; numeric scores and probabilities are not needed. Ground claims in known systems and a bounded look at the repository, and link evidence where useful. Mark unverified claims and any unknown that could change the decision.

Apply the same comparison to the smallest version and to doing nothing: writing no new code can still leave maintenance cost and the original problem in place. Weigh user value alongside complexity when recommending; the simplest option is sometimes the wrong one. This analysis lives in the options page. The plan carries forward only the chosen trade-off and its important constraints.

Example (illustrative only): “Scheduled delivery adds durable pending state and cancellation/retry behavior to the existing send flow. The main risks are duplicate sends and races between editing and dispatch; ongoing maintenance includes failed-job recovery. Limiting the first version to one-off sends avoids recurrence and timezone-rule complexity, but users must schedule each occurrence themselves.”

## Prior art is checked, not assumed

For each option, say what well-known apps or products do for the same behaviour and how you know: a help page, documentation, a checked device, or cited findings from the `research-web` skill. Mark anything you could not check as unverified. A familiar comparison that turns out false makes the wrong option look like the safe default, so leave it out rather than guess. When no comparable product exists, say so.
