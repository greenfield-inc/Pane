# Oxlint and ESLint overlap

`pnpm lint:ox` is the first blocking lane. ESLint remains blocking for rules
whose current Pane semantics are not reproduced by Oxlint 1.76.0, and continues
to report the repository's existing warning-level checks. An ESLint rule is
disabled in `tools/eslint/oxlint-overlap.cjs` only when the explicit blocking
Oxlint rule below replaces it.

The 79 unique ESLint error-level rules were resolved from the frontend, main,
and RunPane flat configs. Seventy-eight have blocking equivalents. `no-octal`
has no Oxlint 1.76.0 equivalent and therefore stays in ESLint.

| ESLint rule | Blocking Oxlint rule | Scope/disposition |
| --- | --- | --- |
| `for-direction` | `eslint/for-direction` | common; moved |
| `no-async-promise-executor` | `eslint/no-async-promise-executor` | common; moved |
| `no-case-declarations` | `eslint/no-case-declarations` | common; moved |
| `no-compare-neg-zero` | `eslint/no-compare-neg-zero` | common; moved |
| `no-cond-assign` | `eslint/no-cond-assign` | common; moved |
| `no-constant-binary-expression` | `eslint/no-constant-binary-expression` | common; moved |
| `no-constant-condition` | `eslint/no-constant-condition` | common; moved |
| `no-control-regex` | `eslint/no-control-regex` | common; moved |
| `no-debugger` | `eslint/no-debugger` | common; moved |
| `no-delete-var` | `eslint/no-delete-var` | common; moved |
| `no-dupe-else-if` | `eslint/no-dupe-else-if` | common; moved |
| `no-duplicate-case` | `eslint/no-duplicate-case` | common; moved |
| `no-empty` | `eslint/no-empty` | frontend only; moved (main/RunPane warning retained) |
| `no-empty-character-class` | `eslint/no-empty-character-class` | common; moved |
| `no-empty-pattern` | `eslint/no-empty-pattern` | common; moved |
| `no-empty-static-block` | `eslint/no-empty-static-block` | common; moved |
| `no-ex-assign` | `eslint/no-ex-assign` | common; moved |
| `no-extra-boolean-cast` | `eslint/no-extra-boolean-cast` | common; moved |
| `no-fallthrough` | `eslint/no-fallthrough` | common; moved |
| `no-global-assign` | `eslint/no-global-assign` | common; moved |
| `no-invalid-regexp` | `eslint/no-invalid-regexp` | common; moved |
| `no-irregular-whitespace` | `eslint/no-irregular-whitespace` | common; moved |
| `no-loss-of-precision` | `eslint/no-loss-of-precision` | common; moved |
| `no-misleading-character-class` | `eslint/no-misleading-character-class` | common; moved |
| `no-nonoctal-decimal-escape` | `eslint/no-nonoctal-decimal-escape` | common; moved |
| `no-octal` | — | common; retained in ESLint |
| `no-prototype-builtins` | `eslint/no-prototype-builtins` | common; moved |
| `no-regex-spaces` | `eslint/no-regex-spaces` | common; moved |
| `no-self-assign` | `eslint/no-self-assign` | common; moved |
| `no-shadow-restricted-names` | `eslint/no-shadow-restricted-names` | common; moved |
| `no-sparse-arrays` | `eslint/no-sparse-arrays` | common; moved |
| `no-unexpected-multiline` | `eslint/no-unexpected-multiline` | common; moved |
| `no-unsafe-finally` | `eslint/no-unsafe-finally` | common; moved |
| `no-unsafe-optional-chaining` | `eslint/no-unsafe-optional-chaining` | common; moved |
| `no-unused-labels` | `eslint/no-unused-labels` | common; moved |
| `no-unused-private-class-members` | `eslint/no-unused-private-class-members` | common; moved |
| `no-useless-backreference` | `eslint/no-useless-backreference` | common; moved |
| `no-useless-catch` | `eslint/no-useless-catch` | common; moved |
| `no-var` | `eslint/no-var` | common; moved |
| `prefer-const` | `eslint/prefer-const` | frontend only; moved (main/RunPane warning retained) |
| `prefer-rest-params` | `eslint/prefer-rest-params` | common; moved |
| `prefer-spread` | `eslint/prefer-spread` | common; moved |
| `require-yield` | `eslint/require-yield` | common; moved |
| `use-isnan` | `eslint/use-isnan` | common; moved |
| `valid-typeof` | `eslint/valid-typeof` | common; moved |
| `@typescript-eslint/ban-ts-comment` | `typescript/ban-ts-comment` | common; moved |
| `@typescript-eslint/no-array-constructor` | `typescript/no-array-constructor` | common; moved |
| `@typescript-eslint/no-duplicate-enum-values` | `typescript/no-duplicate-enum-values` | common; moved |
| `@typescript-eslint/no-empty-object-type` | `typescript/no-empty-object-type` | common; moved |
| `@typescript-eslint/no-explicit-any` | `typescript/no-explicit-any` | common; moved |
| `@typescript-eslint/no-extra-non-null-assertion` | `typescript/no-extra-non-null-assertion` | common; moved |
| `@typescript-eslint/no-misused-new` | `typescript/no-misused-new` | common; moved |
| `@typescript-eslint/no-namespace` | `typescript/no-namespace` | common; moved |
| `@typescript-eslint/no-non-null-asserted-optional-chain` | `typescript/no-non-null-asserted-optional-chain` | common; moved |
| `@typescript-eslint/no-require-imports` | `typescript/no-require-imports` | frontend only; moved (main/RunPane warning retained) |
| `@typescript-eslint/no-this-alias` | `typescript/no-this-alias` | common; moved |
| `@typescript-eslint/no-unnecessary-type-constraint` | `typescript/no-unnecessary-type-constraint` | common; moved |
| `@typescript-eslint/no-unsafe-declaration-merging` | `typescript/no-unsafe-declaration-merging` | common; moved |
| `@typescript-eslint/no-unsafe-function-type` | `typescript/no-unsafe-function-type` | common; moved |
| `@typescript-eslint/no-unused-expressions` | `typescript/no-unused-expressions` | common; moved |
| `@typescript-eslint/no-wrapper-object-types` | `typescript/no-wrapper-object-types` | common; moved |
| `@typescript-eslint/prefer-as-const` | `typescript/prefer-as-const` | common; moved |
| `@typescript-eslint/prefer-namespace-keyword` | `typescript/prefer-namespace-keyword` | common; moved |
| `@typescript-eslint/triple-slash-reference` | `typescript/triple-slash-reference` | common; moved |
| `react-hooks/rules-of-hooks` | `react/rules-of-hooks` | frontend only; moved |
| `jsx-a11y/alt-text` | `jsx-a11y/alt-text` | frontend only; moved |
| `jsx-a11y/anchor-has-content` | `jsx-a11y/anchor-has-content` | frontend only; moved |
| `jsx-a11y/aria-props` | `jsx-a11y/aria-props` | frontend only; moved |
| `jsx-a11y/aria-proptypes` | `jsx-a11y/aria-proptypes` | frontend only; moved |
| `jsx-a11y/aria-unsupported-elements` | `jsx-a11y/aria-unsupported-elements` | frontend only; moved |
| `jsx-a11y/click-events-have-key-events` | `jsx-a11y/click-events-have-key-events` | frontend only; moved |
| `jsx-a11y/heading-has-content` | `jsx-a11y/heading-has-content` | frontend only; moved |
| `jsx-a11y/iframe-has-title` | `jsx-a11y/iframe-has-title` | frontend only; moved |
| `jsx-a11y/no-access-key` | `jsx-a11y/no-access-key` | frontend only; moved |
| `jsx-a11y/no-distracting-elements` | `jsx-a11y/no-distracting-elements` | frontend only; moved |
| `jsx-a11y/no-static-element-interactions` | `jsx-a11y/no-static-element-interactions` | frontend only; moved with `onClick`/expression options |
| `jsx-a11y/role-has-required-aria-props` | `jsx-a11y/role-has-required-aria-props` | frontend only; moved |
| `jsx-a11y/role-supports-aria-props` | `jsx-a11y/role-supports-aria-props` | frontend only; moved |
| `jsx-a11y/tabindex-no-positive` | `jsx-a11y/tabindex-no-positive` | frontend only; moved |

Both Oxlint configs disable the broad `correctness` category. This is
intentional: the blocking contract is the explicit list above plus the 15
zero-baseline anti-slop rules, rather than an unstable category preset.

A Profiler-based render counter is deliberately deferred. Add one with the
first named React subscription/render regression and a component test renderer
that can mount the affected Pane surface; React Scan supplies exploratory
runtime evidence but is not a deterministic unit-test assertion.
