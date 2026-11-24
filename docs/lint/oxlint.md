# Oxlint

Oxlint is Pane's only linter. `pnpm lint:code` runs it with `.oxlintrc.json`
over the whole repository, then the boundary-decoder conformance check and the
agent-facts check. `pnpm lint` adds Knip.

`pnpm lint:ox` (`scripts/oxlint.mjs`) splits the files `git ls-files` lists
into up to four groups and runs one Oxlint process per group. Oxlint runs the
anti-slop rules on one JavaScript thread per process, so a single process
leaves the other cores idle. Arguments after it reach every process, and each
process prints its own report.

## What is on

`.oxlintrc.json` turns on every Oxlint category except `nursery`
(`correctness`, `suspicious`, `perf`, `pedantic`, `restriction`, `style`) for
the `eslint`, `typescript`, `unicorn`, `oxc`, `react`, `jsx-a11y`, `promise`,
`node`, `vitest` and `react-perf` plugins, plus the 15 anti-slop
rules ([anti-slop.md](anti-slop.md)) and Pane's own rules (below). Every rule is an error except the two
renderer warnings below.

A rule is `off` in the `rules` block only when the code does not pass it yet.
To turn one on, fix its findings and delete its `off` line. An Oxlint upgrade
that adds a rule to one of these categories turns it on: fix the findings, or
add it to the `off` list with its reason below.

Rules with options or a narrower scope:

| Rule | Where | Setting |
| --- | --- | --- |
| `eslint/no-unused-vars` | everywhere | names starting with `_` and rest-sibling omissions are allowed |
| `eslint/prefer-const` | everywhere | a variable a closure reads before its one assignment may stay `let` |
| `jsx-a11y/no-static-element-interactions` | everywhere | checks `onClick` only |
| `typescript/no-require-imports` | `frontend/src`, `main/src`, `packages/runpane/src`, `mobile/src`, `mobile/scripts` | error |
| `eslint/no-console` | `frontend/src` | `console.warn` and `console.error` allowed |
| `react/exhaustive-deps` | `frontend/src` | warning |
| `react/only-export-components` | `frontend/src` | warning, constant exports allowed |

Legacy octal literals (ESLint's `no-octal`) and `\8`/`\9` escapes are parse
errors in TypeScript and ES modules, so Oxlint reports them without a rule.
Plain CommonJS scripts are not checked for them. `eslint/no-irregular-whitespace`
does not look inside comments or regular expression literals.

## Pane's own rules

`tools/oxlint/pane` is a JS plugin, like anti-slop, for rules specific to this
codebase. `scripts/todo-key-lint.test.mjs` tests it on fixtures.

`pane/no-bare-todo-number` (T-51): every machine numbers its own to-dos T-1,
T-2 and so on, so two machines each have a T-28. The rule fails when a bare
to-do number (`x.todo.number`, `x.todoNumber`, `x.todo_id`) is compared with
`===`, `!==`, `==` or `!=`, looked up with `includes` or `indexOf`, or used as
a Map, Set or record key. Compare and key by a `TodoKey` from
`shared/todoKey.ts` instead, the one file the rule skips. Showing a number
(`` `T-${n}` ``, `todoRef(n)`), passing it on, and checking it against `null`
or `undefined` are allowed. The rule reads names, not types, so a `todo`
destructured from a row (`({ todo }) => todo.number`) is not checked.

Where it is off, and why:

| Where | Reason |
| --- | --- |
| `main/src/services/todos/**`, `main/src/ipc/todos.ts` | Main's to-do service reads only this machine's database, so every number in it is this machine's. |
| `tests/**`, `**/*.test.ts(x)` | Fixtures hold one machine's to-dos and assert on the numbers they set up. |
| `frontend/src/components/todos/page/todoSessionLink.ts` (one line) | The Session, its record's number and the rows all come from the computer the window shows. |

## Why a rule is off

The `import` plugin is off as a whole. With it on, Oxlint resolves every
import into a module graph before linting, which doubled lint time, and the
type check already rejects missing exports and unresolved paths.

`pedantic`, `restriction` and `style` rules are off where the code follows a
different convention (for example `sort-keys`, `no-magic-numbers`, `curly`,
`func-style`). Adopting one is a codebase-wide rewrite.

The `correctness`, `suspicious` and `perf` rules that are off:

| Rule | Reason |
| --- | --- |
| `react/react-in-jsx-scope` | The renderer uses the automatic JSX runtime. |
| `jsx-a11y/*` (12 rules) | Each fix changes markup or focus behaviour; needs its own UI change. |
| `react/exhaustive-deps`, `react/only-export-components` | Warnings in `frontend/src`, as before; fixing a dependency list changes when an effect runs. |
| `vitest/require-mock-type-parameters`, `no-conditional-expect`, `require-to-throw-message`, `valid-expect`, `expect-expect`, `no-standalone-expect` | Test style; `no-standalone-expect` also reports expectations in hooks and helpers. |
| `unicorn/no-useless-spread`, `no-array-sort`, `no-array-reverse`, `consistent-function-scoping`, `prefer-add-event-listener`, `no-instanceof-builtins`, `prefer-array-find`, `prefer-set-has` | Rewrites that keep behaviour but touch many files. |
| `unicorn/no-new-array` | Reports sized `new Array(n)` used to preallocate results. |
| `unicorn/no-array-fill-with-reference-type` | Reports canvas `context.fill` and read-only fixtures. |
| `unicorn/require-module-specifiers` | Reports `export {}`, which marks a file as a module. |
| `unicorn/require-post-message-target-origin` | Reports `postMessage` on workers and ports, which take no origin. |
| `eslint/no-new` | Reports `new URL(...)` used as a validity check. |
| `eslint/no-await-in-loop` | Most loops are deliberately sequential. |
| `eslint/no-shadow`, `no-underscore-dangle`, `no-unmodified-loop-condition`, `preserve-caught-error` | Naming and error-wrapping conventions the code does not follow yet. |
| `promise/always-return`, `no-callback-in-promise`, `no-multiple-resolved`, `no-promise-in-callback` | Callback-style code that a rewrite to `async` would fix. |
| `typescript/no-extraneous-class` | Static-only classes are part of existing APIs. |
| `react/no-unstable-nested-components`, `no-array-index-key`, `no-object-type-as-default-prop`, `jsx-no-constructed-context-values`, `iframe-missing-sandbox` | Each fix changes rendering; needs its own UI change. |
| `react-perf/*`, `oxc/no-map-spread` | Allocation advice the renderer does not follow; React Compiler territory. |

A Profiler-based render counter is deliberately deferred. Add one with the
first named React subscription/render regression and a component test renderer
that can mount the affected Pane surface; React Scan supplies exploratory
runtime evidence but is not a deterministic unit-test assertion.
