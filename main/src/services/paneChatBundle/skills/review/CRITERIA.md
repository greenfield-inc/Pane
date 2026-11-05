# Code Review Criteria

Shared review criteria used by the PR review skill. This file is project-agnostic. Each repo may append a per-repo section for project-specific rules; the discovery step below tells the reviewer how to find and apply them.

---

## 0. Discovery (Required First Step)

Before applying any criterion below, derive the project's actual floor from the repo itself. Read these sources in priority order and let them override anything generic in this file:

1. **AGENTS.md** (or CLAUDE.md) -- project conventions, forbidden patterns, tooling
2. **Lint configuration and blocking custom rules** -- the CI-enforced floor for new code
3. **Compiler/build configuration, when present** -- e.g. tsconfig, pyproject.toml, Cargo.toml
4. **Manifests and CI** -- the frameworks, toolchains, and checks actually used

Where the derived floor conflicts with a generic criterion below, the repo's own rules win. State the override explicitly in the review rather than silently ignoring either source.

Apply stack- and product-specific examples only where relevant; React, TypeScript,
UI panels, and JavaScript conventions are not requirements for other projects.

---

## Severity (how bad a finding is)

Sections 1 to 6 are a checklist of what to look for. Their category never sets a finding's severity: a race condition can be a Suggestion and a TypeScript gap can be Must-Fix. Grade every finding by its consequence, answering three questions:

- **Harm:** what goes wrong when it happens. High: a wrong answer, data lost or damaged, a security hole, or something silently stuck. Medium: stale or misleading output, or an action blocked that should work. Low: cosmetic, a confusing message, or a clear error.
- **Reach:** who hits it. High: the normal path, every user or every orchestrator. Medium: a common but not default path. Low: needs a rare timing, platform or setup.
- **Recovery:** what happens next. Silent: nobody notices, or there is no workaround. Visible: the failure shows and an obvious workaround exists.

Then pick the level:

- **Must-Fix (blocks merge):** high harm and (high reach or silent). Also, whatever the reach: any security issue, any PHI exposure (PHI reaching a log, error, analytics or telemetry event, cache, URL, third party or client storage without a control), any data loss, and any broken promise in a public contract: machine-readable output other programs parse, such as JSON fields, exit codes and error codes.
- **Should-Fix (fix in this PR unless the author explains why not):** high harm that is rare and visible, or medium harm on the normal path. A promise stated only in human-readable text or docs, even a small one.
- **Suggestion:** low harm, or a convention or style point that lint doesn't enforce.
- **Don't raise:** anything lint, typecheck or CI already enforces. Report a failing gate as a gate failure instead.

Otherwise: Should-Fix if any answer is high or silent, else Suggestion.

Use only these level names. No P0/P1/P2, "critical", "nit" or other labels.

Every finding states its grading in one line, so a reader can disagree with a specific answer:

```text
Harm: high (orchestrator trusts a dead worker) · Reach: high (any agent that exits) · Recovery: silent → Must-Fix
```

Calibrate against the worked examples in [severity-examples.md](severity-examples.md).

---

## 1. Bugs and Correctness

- Logic errors: incorrect conditionals, off-by-one, wrong comparison operators
- Null/undefined risks: missing optional chaining, unhandled nullable paths
- Async bugs: missing `await`, unhandled promise rejections, race conditions
- Error handling: missing `try/catch` on calls that can throw, unhandled error states
- State bugs: stale closures in hooks, missing dependency array entries
- Query cost at 1M active users: an index serves every new or changed query, and hot paths (page loads, badges, counters, polling) never scan or count a growing table
- Hot-path cost: no CPU, memory, render or latency cost on a hot path that grows with data. A finding names the hot path, the scale and an estimate, or it is dropped
- Cost at production size: a change that adds or alters a database query, scan or loop on a request path states the work it does for the largest real input (the biggest account, team or list in production, not the test fixture) and shows it meets the repo's budget. On a hot path, an unmeasured or unbounded worst case is Must-Fix: Harm high (a slow query on the normal path degrades production) · Reach high · Recovery silent until users notice. Here the missing measurement is the finding, so it needs no estimate of your own. The repo's AGENTS.md names its hot paths, budget and where production sizes are recorded; if it names none, the finding asks the author for them

## 2. Security

- `dangerouslySetInnerHTML` without DOMPurify sanitization
- API keys, tokens, or credentials in frontend code
- User input rendered without sanitization
- Command injection or XSS vectors
- Auth/permission checks missing on new endpoints or IPC channels
- PHI (diagnosis, condition, medication, lab result, clinical note, insurance or member id, or a patient record tied to a person) reaching logs, errors, analytics, telemetry, caches, URLs, third parties or client storage without redaction or an approved path
- Every security or PHI finding names its source, its sink and the missing control, or it is dropped

## 3. React and Component Design

- Components under 200-300 lines; JSX under ~50 lines per component
- Single responsibility -- business logic separated from presentational rendering
- Props destructured at the function signature, explicitly typed
- Prop drilling through 3+ levels replaced with Context or state management
- Hooks never called inside loops, conditionals, or nested functions
- `useEffect` dependency arrays complete; cleanup functions present for subscriptions/timers
- `useCallback` on functions passed as props to child components
- `useMemo` only on genuinely expensive computations
- `useState` not used for values derivable from props or other state
- Error Boundaries at critical subtree boundaries
- Loading, error, and empty states all handled explicitly
- List rendering uses stable unique keys (never array index for dynamic lists)
- `React.lazy` + `Suspense` for code-split routes and heavy components

## 4. TypeScript

- No explicit `any` -- use a specific type or `unknown` with narrowing
- No `{}` as a type -- use `Record<string, unknown>` or a named interface
- Type assertions (`as X`) include a comment explaining why
- Double assertions (`as unknown as X`) are a blocking error, not just a smell
- `import type` used for type-only imports
- Interfaces preferred over type aliases for object shapes
- No `I` prefix on interface names

## 5. UX Fit and Placement

Applies to any change that adds or moves user-facing surface: a control, a
panel, a tab, a widget, a toggle, a setting. Ask these before the code
questions, since a correct widget in the wrong place still costs every user.

- **Placement matches the information's scope.** Account-level information
  (usage, plan, billing, identity) lives in Settings; per-item information
  lives beside the item; global actions live in a global bar.
- **Progressive disclosure.** A surface appears when it can show something
  and stays hidden otherwise. Detection beats a toggle.
- **Scoped to the panels it concerns.** A control for one agent or tool
  shows only where that agent runs, never on every panel type.
- **One way to reach it.** A hidden toggle plus a persisted preference plus
  an auto-open is three behaviours to discover; one predictable path is the
  standard.
- **Fits the surface it joins.** A crowded bar stays sparse; a new affordance
  earns its place against what is already there, and joins an existing home
  before creating a rival one.
- **Comparable products.** Where do mature tools put this? A placement no
  comparable product uses needs a stated reason.

Recommend the placement, name why, and give the path to it. The plumbing
under a misplaced surface is usually right and reusable; say so.

## 6. Conventions

- File names match their default export
- `const` by default, `let` only when reassignment required, never `var`
- No `console.log` in committed code (except intentional server-side logging)
- No commented-out code blocks or dead code
- No unused imports or variables

## 7. Routing

Every Must-Fix and Should-Fix carries two routing answers, set when it is found and re-checked when you verify it. An orchestrator routes on them; run by hand, they tell the person what the fix would take.

- **Scope: in | out.** In when the fix stays inside what this PR changes or the plan's scope; out when it lies elsewhere (code the PR does not touch, another item's work, a follow-up).
- **Approach/scope: no | yes.** Yes when fixing it would need a different approach or a change to the work's scope: a broken premise, missing planned work, a plan-level gap (or, without a plan, work the linked issue did not ask for). Say in one line what plan change it would need.

When your verification and the finder disagree on a routing answer, keep the one that sends the finding to the person (scope out, flag yes) and say why.

