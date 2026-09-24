---
name: quick-verify
description: Use while working to confirm a change does what you meant before moving on. Observe its real effect the way a user or caller would, compare that with your intent, fix what is off, and observe again.
---

# Quick verify

Code that compiles, and tests that pass, can still do the wrong thing. The only proof is the real effect, seen from where it matters. Run this loop yourself, between edits, in minutes. It is not a full QA pass; use `qa-and-verify` for that on a finished pull request.

## The loop

1. **Say what "working" looks like.** One or two sentences, in terms someone could see: "the settings page shows the new toggle, off by default", "`export --csv` writes a header row". If you cannot say it, you are not ready to check it.
2. **Pick the most faithful cheap way to observe it.** Look from where the effect lands: the screen a user sees, the response a caller gets, the file or row that gets written, the log a job emits. Prefer the tool the repository already uses. Find how to run things in `AGENTS.md`, the README, or the package scripts, and never invent a launch command.
3. **Produce the state.** Run the app, command, or job with realistic input. Reuse what is already running; stop only what you start.
4. **Capture evidence.** Save it under `tmp/verify/<change>/` with ordered names (`01-before`, `02-after`) so each attempt sits next to the last. Capture the states that matter, not only the happy path.
5. **Judge it critically.** Compare it with step 1, then check around the change for what else it touched. Believe the evidence over your expectation.
6. **Fix and observe again** the same way, until the evidence shows what you meant.

## Examples

| Change | Observe | Look for |
| --- | --- | --- |
| Web UI | Screenshot the dev server (Playwright, Cypress, or a temporary script) | Layout, spacing, empty and error states, a narrow viewport |
| Mobile UI | Simulator or device screenshot | The same, plus safe areas and keyboard overlap |
| API or backend | One real request, and read the response and the logs | Status, shape, edge input, the error path |
| CLI or script | Run it with real arguments | Output, exit code, files written |
| Job, queue, or migration | Run it once on test data, then read what changed | The rows or records it touched, and running it twice |
| Library function | Call it from a scratch script or one focused test | Return value at the edges |
| Docs or copy | Render it and read it as a newcomer would | Wrong commands, missing steps |

## Always

- Never commit anything under `tmp/verify/`, and never point a check at production.
- Report what you checked, how, and what you did not check.
