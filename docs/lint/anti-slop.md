# Anti-slop policy

Pane vendors the 15 Oxlint rules from `dmmulroy/anti-slop` at commit
`cd064fe602b5915ff35e1e1c20836ca9bcb3729a` in
`tools/oxlint/anti-slop`. The snapshot is intentionally local so the rules run
deterministically and can be reviewed alongside the code they gate.

The original full-repository scan covered `frontend`, `main`,
`packages/runpane`, `shared`, `tests`, `scripts`, all non-vendored `tools`, and
every Playwright config. It found 2,463 findings in 240 files. The cleanup
campaign reduced every rule to a zero baseline, so all 15 rules now block
regressions in the root lint command.

| Rule | Baseline findings/files | Lane | Reason |
| --- | ---: | --- | --- |
| `no-object-parameters` | 0/0 | blocking | Prevent new positional object bags without an explicit contract. |
| `no-reflect-apply` | 0/0 | blocking | Prefer direct, typed calls over reflective dispatch. |
| `no-unknown-type-aliases` | 0/0 | blocking | Prevent aliases that rename uncertainty instead of parsing it. |
| `no-widen-then-assert` | 0/0 | blocking | Prevent discarding known types and recovering them with assertions. |
| `no-reflect-get` | 4/1 | blocking | Reflective reads were replaced with declared or descriptor-based access. |
| `no-chained-type-assertions` | 89/22 | blocking | Boundary contracts avoid type laundering through chained assertions. |
| `no-conditional-empty-object-spread` | 34/16 | blocking | Optional fields are assembled explicitly. |
| `no-known-value-widening` | 142/65 | blocking | Known values retain inferred or named domain types. |
| `no-module-mocking` | 31/13 | blocking | Tests use explicit seams or real modules. |
| `no-runtime-typeof` | 417/94 | blocking | Runtime boundaries use parsers, feature checks, or domain guards. |
| `no-shape-in-symbol-names` | 18/1 | blocking | Symbols describe domain intent rather than structural shape. |
| `no-unknown-parameters` | 250/64 | blocking | Uncertain input is parsed at its boundary. |
| `no-unknown-returns` | 37/21 | blocking | Adapters return parsed domain values. |
| `no-unsafe-dictionary-type` | 192/51 | blocking | Dictionary contracts use bounded keys or validated JSON objects. |
| `require-safety-comment-for-type-assertion` | 1,249/177 | blocking | Remaining necessary assertions document their checked invariant. |

Run `pnpm lint` for the blocking policy. `pnpm lint:ox:extra` and
`pnpm lint:ox:extra:details` remain available as harness checks, but no rules
remain in the advisory lane.

## Root cause policy

For agent-written Pane code, the most important class is uncertainty that leaks
past an I/O boundary and later becomes a widening or assertion. Ask: **is this
change fixing the root cause or a symptom?** The root fix parses IPC, daemon,
filesystem, process, or browser input once into a named domain type. A late
`unknown` alias, representation ladder, dictionary, or assertion usually treats
the symptom. Blocking findings should guide that review.

Any future anti-slop rule must reach a zero baseline for the full scope before
joining the blocking configuration. Do not silence a class globally to make a
promotion appear clean.

The root development toolchain requires Node 22.18 or newer because Oxlint's
TypeScript plugin runs under the developer Node process. This does not change
Electron 41's bundled Node 24 runtime, and the published `runpane` wrapper keeps
its Node 20 runtime floor.
