# Profiles

A profile is one YAML file that defines a team of agents and a fixed workflow.
Pane draws the workflow, launches it on any terminal CLI, and runs it step by
step from the file. greenfield is the first profile and ships with Pane, on by
default.

## The format: pane-profile/1

Four primitives: **agent**, **step** (an agent step or a command), **outcome**
and **ask**.

```yaml
format: pane-profile/1
name: greenfield            # lowercase, digits, dashes; unique
version: 1.0.0              # semver
title: Plan, build and review, one Pane per feature
# extends: greenfield@^1.0  # an overlay: only your changes to an installed profile
# loop_limit: 3             # times a run may take one loop edge before it asks

agents:                     # who does judgment work
  planner: { runs: claude/claude-opus-5-5, effort: high, reads: [standing-rules], skills: [plan] }

flow:                       # the graph: fixed, drawn one box per step
  start: plan
  plan:    { agent: planner, goal: Turn the request into a plan,
             outcomes: { plan ready: approve, needs you: answer } }
  answer:  { ask: Answer the planner's question, next: plan }
  approve: { ask: Approve the plan?, choices: { approve: build, change it: plan } }
  build:   { run: npm test, title: Tests, outcomes: { green: end, red: plan } }

samples:                    # 2 or more per agent outcome
  plan:
    plan ready: ["Plan: …", "Plan: …"]
    needs you: ["Q-1: …", "Q-1: …"]

runs:                       # optional example runs the viewer lights up
  A: [ { plan: "plan ready #1" }, { approve: approve }, { build: green } ]
```

- `runs:` on an agent is `cli/model` or a CLI alone; a CLI Pane doesn't know
  is allowed and runs on the terminal baseline.
- An agent step has a `goal` and at least one outcome. A command (`run:`) has
  two outcomes, taken on exit 0 and on any other exit, or none, which ends the
  run. An ask has `choices` (buttons) or `next` (a typed answer). Any outcome,
  choice or next may point to `end`.
- `reads` are file ids in the profile's folder (`instructions/<id>.md` or
  `<id>.md`; for a bundled profile, the bundled Agent Farm plugin's folder).
  `skills` are skill names.
- A profile without `flow` is **team only**: listed and viewable, not
  launchable.

Validation (`shared/profiles/validateProfile.ts`) names the step and outcome of
each error and says how to fix it, for example: "Step review, outcome findings
has 1 sample. Every outcome of an agent step needs at least 2, so its picture
can show how results vary." A profile with any error is listed as invalid and
can't launch.

## Where profiles come from

| Kind | Where | On |
| --- | --- | --- |
| Bundled | `main/src/services/profiles/bundled/`; greenfield's agents, and the team-only orchestra, bigbrain and machine-security, are written by `node scripts/import-agent-farm-profiles.js` from the pinned Agent Farm | greenfield by default; config `profiles.enabled` lists the bundled ones that are on |
| Yours | `<PANE_DIR>/profiles/*.profile.yaml` | always |
| Your Agent Farm | your own `agent-farm profiles list`, when one is on PATH (read-only) | runs through your agent-farm (+ menu › Profile…) |

An overlay (`extends: <name>@<range>`) holds only its changes; agents and steps
merge key by key and `null` removes one. Pane ships Agent Farm
(`@greenfieldco/agent-farm`) and installs its plugins into
`<PANE_DIR>/agent-farm` at start; see "Agent Farm profiles" in
[CHAT_TABS.md](CHAT_TABS.md).

## Running a profile

Launch from the Profiles page (sidebar, under Loops), the + menu's
**Profile…**, or `runpane profiles launch`. A run belongs to a Session (one you
pick, or a new one). The first step opens a new Pane; every later step opens as
a terminal tab in it.

| Step | Moves on when |
| --- | --- |
| Agent step | its agent runs `runpane report --outcome "<name>"` with a declared outcome; an undeclared one is refused, listing the allowed ones |
| Command | its tab exits: 0 takes the first outcome, anything else the second |
| Ask | you answer its card in Approvals |

The first message names the goal, the request, the previous step's result, the
files to read and the report command. A loop edge (one pointing back in the
file) taken more than `loop_limit` times pauses the run with "This loop ran 3
times: go again, or stop?". A step whose tab closed without an outcome asks
which one it had; **Set outcome…** on the page does the same by hand.

Each run is `<Session folder>/profile-runs/<run id>.json`, written before every
move, so a restart resumes runs without starting anything twice.
Code: `main/src/services/profiles/` (`flowMachine.ts`, `profileRunner.ts`,
`profileRunnerHost.ts`), `main/src/ipc/profiles.ts`,
`frontend/src/components/profiles/`.

## runpane and MCP

```sh
runpane profiles list [--json]
runpane profiles show <name> [--yaml] [--json]
runpane profiles launch <name> --prompt <text> [--repo <selector>] [--session <id|name>] \
  [--harness <cli>] [--agent-harness <agent>=<cli>]… [--command <cli>=<command>]… [--json]
runpane profiles runs [--json]
runpane report --outcome "<name>" [--summary-file <file>]   # inside a step's tab
```

The `pane` MCP server has `profiles_list`, `profiles_show`, `profiles_launch`
and `profiles_runs`, with the same JSON. See
[RUNPANE_CLI_CONTRACT.md](RUNPANE_CLI_CONTRACT.md).
