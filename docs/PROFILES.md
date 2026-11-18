# Profiles

A profile is one YAML file that defines a team of agents and a fixed workflow.
Pane draws the workflow, launches it on any agent CLI (Claude Code, Codex, or
any other command), and runs it step by step from the file. Pane bundles
greenfield (plan, build and review) and one profile per dcouple agent; their
instructions and skills come from Agent Farm (`@greenfieldco/agent-farm`),
which Pane bundles too.

Profiles is off until you turn it on in **Settings › Advanced › Profiles**
(`profilesEnabled` in `<PANE_DIR>/config.json`). While it is off, the Profiles
page, its sidebar entry and the + menu's **Profile…** are hidden, and `runpane
profiles` and the profile MCP tools fail with `PROFILES_OFF` and say how to
turn it on. Runs already started keep going. Turning it on shows everything at
once, with no restart.

## The format: pane-profile/1

A profile has agents and a flow of steps. A step is an agent step, a command or
an ask, and moves on through its outcomes.

```yaml
format: pane-profile/1
name: greenfield            # lowercase, digits, dashes; unique
version: 1.0.0              # semver
title: Plan, build and review, one Pane per feature
# extends: greenfield@^1.0  # an overlay: only your changes to an installed profile
# loop_limit: 3             # times a run may take one loop edge before it asks (default 3)

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

- `runs:` on an agent is `cli/model` or a CLI alone. A CLI Pane doesn't know is
  allowed: Pane starts it in a plain terminal tab whose shell exits with it, and
  types the first message.
- An agent step has a `goal` and at least one outcome. A command (`run:`) has
  two outcomes or none: the first is taken on exit 0, the second on any other
  exit, and with none the run ends after the command. It runs as the tab's own
  process (`exec /bin/sh -c '<command>'` on macOS, Linux and WSL). An ask has `choices` (buttons) or `next` (a typed answer). Any outcome,
  choice or next may point to `end`.
- `reads` are file ids in the profile's folder (`instructions/<id>.md` or
  `<id>.md`, never outside it; for a bundled profile, the bundled Agent Farm
  plugin's folder, so greenfield's agents read their Agent Farm role prompt as
  `agents/<name>`). An overlay's reads resolve in its own folder, then its
  base's. `skills` are skill names.
- `samples` gives two or more example results for each outcome of an agent
  step; the Profiles page shows them in the drawing.
- Top-level `runs:` lists example paths through the flow, which the page
  highlights; `plan ready #1` means that outcome with its first sample.
- A profile without `flow` is listed and viewable, marked **no flow**, and
  can't launch.

Validation (`shared/profiles/validateProfile.ts`) names the step and outcome of
each error and says how to fix it, for example: "Step review, outcome findings
has 1 sample. Every outcome of an agent step needs at least 2, so its picture
can show how results vary." A key Pane doesn't read is an error, so a misspelt
one isn't silently dropped. Pane refuses files over 512 KB, and nested YAML aliases that expand past that. A
profile with any error is listed as invalid and can't launch.

## Where profiles come from

| Kind | Where | On |
| --- | --- | --- |
| Bundled | `main/src/services/profiles/bundled/`; greenfield's agents and the dcouple profiles are written by `node scripts/import-agent-farm-profiles.js` from the pinned Agent Farm | greenfield by default; `profiles.enabled` in `<PANE_DIR>/config.json` lists the bundled ones that are on |
| Yours | `<PANE_DIR>/profiles/*.profile.yaml` | always |

A bundled file named `<plugin>.profile.yaml` or `<plugin>.<profile>.profile.yaml`
reads its files from that Agent Farm plugin. dcouple's Agent Farm profiles have
no flow, so each is bundled as `dcouple-<profile>`: its default variant's agent
in one step that ends the run when the agent reports `done`.

Your own Agent Farm profiles (`agent-farm profiles list`, when one is on PATH)
aren't on the Profiles page: open one by name from + menu › **Profile…**, and
`runpane profiles list --json` lists them.

An overlay (`extends: <name>@<range>`) holds only its changes; agents and steps
merge key by key and `null` removes one. Pane ships Agent Farm
(`@greenfieldco/agent-farm`) and installs its plugins into
`<PANE_DIR>/agent-farm` at start; see "Agent Farm profiles" in
[CHAT_TABS.md](CHAT_TABS.md).

## Running a profile

The Profiles page (sidebar, above Loops) lists the bundled profiles under
**On** and **Ready to add**, then yours. A profile opens on its title, what
Launch does, and its flow; **Details** shows its version, the Team and YAML
tabs, the example runs, the key and each outcome's samples.

Launch from the Profiles page, the + menu's
**Profile…** (there with chat tabs off too), or `runpane profiles launch`. A
bundled profile launches once it is on. The launch dialog lists the commands
the profile runs on its own. A run belongs to a Session (one you pick, or a new
one). The first step opens a new Pane; every later step opens as
a terminal tab in it.

| Step | Moves on when |
| --- | --- |
| Agent step | its agent runs `runpane report --outcome "<name>"` with a declared outcome; an undeclared one is refused, listing the allowed ones |
| Command | its tab exits: 0 takes the first outcome, anything else the second. A command interrupted by Ctrl+C, a closed tab or a signal asks which outcome it had instead |
| Ask | you answer its card in Approvals (a card with buttons takes only its buttons) |

The first message names the goal, the request, the previous step's result, the
files to read and the report command. A loop edge (one pointing back in the
file) taken more than `loop_limit` times pauses the run with "This loop ran N
times: go again, or stop?". When a step's tab closes without an outcome, Pane
posts a card in Approvals asking which outcome it reached; **Set outcome** on
the page picks one of the agent step's outcomes by hand. A card closed without an
answer is asked again, twice; after that the run waits with a note until Pane
next starts. Stopping a run, or moving it another way, closes its card. The page
refreshes as runs move.

Each run is `<PANE_DIR>/sessions/<Session id>/profile-runs/<run id>.json`, written before every
move, so a restart resumes runs without starting anything twice. Tabs that
Pane's own quit stops move nothing. After the restart, a command step (whose
command Pane doesn't run again) and a step whose tab is gone ask for their
outcome.
Code: `main/src/services/profiles/` (`flowMachine.ts`, `profileRunner.ts`,
`profileRunnerHost.ts`), `main/src/ipc/profiles.ts`,
`frontend/src/components/profiles/`.

## runpane and MCP

```sh
runpane profiles list [--json]
runpane profiles show <name> [--yaml] [--json]
runpane profiles launch <name> --prompt <text> [--repo <selector>] [--session <id|name>] \
  [--harness <cli>] [--agent-harness <agent>=<cli>]… [--command <cli>=<command>]… --yes [--json]
runpane profiles runs [--json]
runpane report --outcome "<name>" [--summary-file <file>]   # inside a step's tab
```

A `--harness` or `--agent-harness` CLI Pane doesn't know needs `--command
<cli>=<command>`, or the launch is refused (`PROFILE_CLI_UNKNOWN`). `profiles
show` prints each command step's `run:`.

The `pane` MCP server has `profiles_list`, `profiles_show`, `profiles_launch`
and `profiles_runs` (in the `core` and `profiles` toolsets), with the same JSON;
`profiles_launch` takes `yes: true`. See
[RUNPANE_CLI_CONTRACT.md](RUNPANE_CLI_CONTRACT.md).
