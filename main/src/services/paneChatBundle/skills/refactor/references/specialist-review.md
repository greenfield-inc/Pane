# Specialist review lenses

Use for an explicitly requested comprehensive review, or when a large change
benefits from independent expertise across several layers. Select applicable
lenses; do not launch eleven reviewers for every change. These adapt the archived
`review:all` workflow's eleven prompts into scopes for one configured refactor
agent type. They are prompts, not additional agent definitions.

| Lens | Question to investigate |
| --- | --- |
| Reuse | Does nearby code already solve this problem, and would reuse preserve behavior? |
| Clarity | Which changed control/data flow is difficult to follow, and what concrete error or maintenance risk results? |
| Scope | Does the implementation preserve the requested outcome without unrelated changes? |
| Anti-patterns | Does new code violate a demonstrated repository convention or create a correctness defect? |
| Consistent patterns | Does this introduce a competing implementation for the same operation without a reason? |
| Backend architecture | Are service boundaries, persistence, transactions, and failure paths coherent? |
| Frontend architecture | Are state ownership, rendering, accessibility, and user flows coherent? |
| Documentation | Do public contracts and usage instructions match the changed behavior? |
| Circular dependencies | Do new imports create cycles or runtime initialization hazards? |
| Self-contained components | Are responsibilities and dependencies explicit at the repository's component/module boundaries? |
| Query/cache behavior | When a query/cache library is used, are keys, invalidation, errors, and mutation lifecycles correct? |

The parent dispatches fresh instances of the configured `refactor` role using the
deep-analysis skill with one lens as an explicit scope override. Share the same
base/head and tracked/untracked file inventory; do not share peer findings.
Filter frontend/query/backend lenses to the actual stack. Repository evidence
sets conventions and severity; line-count rules and a preferred architecture
from the archive are not universal requirements.

Run in waves within available capacity. Helpers inspect and return findings;
they do not edit code, post reviews, duplicate checks, or spawn more helpers.
Each returns lens, reviewed revision, report path, file:line evidence, impact,
proposed fix, auto-fixable flag, and uncertainty. The parent reconciles once
using the main skill's rules. Missing/failed lenses remain explicitly unverified.

Historical source: dcouple/skills commit `1c6e4ec8f2adb6e4b3047bf014404655301172a7`,
`.claude/commands/parsa/review/all.md`, preserved under `legacy-parsa/`.
That source used eleven instances of one reviewer type. The adapted version
keeps current evidence, reconciliation, capacity, and authorization boundaries.
