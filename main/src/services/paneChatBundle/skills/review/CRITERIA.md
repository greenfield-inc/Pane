# Code Review Criteria

Shared review criteria used by the PR review skill and the implementation-reviewer agent. This file is project-agnostic. Each repo may append a per-repo section for project-specific rules; the discovery step below tells the reviewer how to find and apply them.

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

## 1. Bugs and Correctness (Must-Fix)

- Logic errors: incorrect conditionals, off-by-one, wrong comparison operators
- Null/undefined risks: missing optional chaining, unhandled nullable paths
- Async bugs: missing `await`, unhandled promise rejections, race conditions
- Error handling: missing `try/catch` on calls that can throw, unhandled error states
- State bugs: stale closures in hooks, missing dependency array entries

## 2. Security (Must-Fix)

- `dangerouslySetInnerHTML` without DOMPurify sanitization
- API keys, tokens, or credentials in frontend code
- User input rendered without sanitization
- Command injection or XSS vectors
- Auth/permission checks missing on new endpoints or IPC channels

## 3. React and Component Design (Should-Fix)

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

## 4. TypeScript (Should-Fix)

- No explicit `any` -- use a specific type or `unknown` with narrowing
- No `{}` as a type -- use `Record<string, unknown>` or a named interface
- Type assertions (`as X`) include a comment explaining why
- Double assertions (`as unknown as X`) are a blocking error, not just a smell
- `import type` used for type-only imports
- Interfaces preferred over type aliases for object shapes
- No `I` prefix on interface names

## 5. UX Fit and Placement (Should-Fix)

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

## 6. Conventions (Suggestion)

- File names match their default export
- `const` by default, `let` only when reassignment required, never `var`
- No `console.log` in committed code (except intentional server-side logging)
- No commented-out code blocks or dead code
- No unused imports or variables
