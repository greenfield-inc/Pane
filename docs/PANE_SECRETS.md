# Pane secrets

Pane secrets are named values, such as API keys, that any agent on your machines can
use without the value showing up in chat. A secret is addressed as
`<project>/<NAME>`: the agent picks the project (`stripe`, `qa`, a repo's name) and
the name follows environment-variable rules, so it can be injected as-is.

Every host Pane syncs keys with keeps its own copy, so a secret works offline and on
every machine. Values stay in the OS store, never in `config.json`, the database,
logs, chat or MCP output.

## Use a secret

Agents and scripts use a secret only through `runpane secrets exec`, which starts a
command with the values in its environment:

```sh
runpane secrets exec --project stripe -- npm test            # every stripe/* secret, under its own name
runpane secrets exec --project stripe --only STRIPE_KEY -- npm test
runpane secrets exec --project stripe --env API_KEY=STRIPE_KEY -- ./deploy.sh
runpane secrets exec --project gcp --file SERVICE_ACCOUNT -- ./upload.sh   # env var holds a path to a 0600 temp file
```

The values are read at call time, so a secret set a moment ago works in a running
agent without a restart. Injected names override the caller's environment. `PATH`,
`WORKTREE_PATH` and `PANE_*` are refused. A `--file` secret is written to a private
temp file that is deleted when the command exits.

No command prints a raw value: there is no `secrets get`. A value reaches a
transcript only if the command you run prints it.

## Ask the person for a secret

`runpane secrets request` (MCP: `secrets_request`) shows a masked card wherever the
person is, through [Notify](PANE_NOTIFY.md):

```sh
runpane secrets request --project stripe --name STRIPE_SECRET_KEY \
  --title "Stripe test secret key" --reason "Run the webhook tests against Stripe's test mode."
```

The person types the value and presses **Save securely**, or **Decline**. The card
says when saving replaces a value that already exists. The agent gets back
`{"status":"saved","project":"stripe","name":"STRIPE_SECRET_KEY"}` or
`{"status":"declined"}`, never the value, and then uses it with `secrets exec`.

The value is saved on the host the agent runs on, the moment it is answered. It
travels once, from the screen that answered to that host, over the same connection
as any Notify answer. That host's own Notify history shows "Saved as
stripe/STRIPE_SECRET_KEY"; other screens drop the card once it is answered. Secret
cards have no Undo.

The card can be answered on the desktop and its floating strip, on another desktop
showing that host, and in the phone app, which uses a secure text field. A
lock-screen alert only opens the app: it has no Reply field, because the system's
reply input is not a secure field. Glasses show "Answer on your phone or computer".

## Manage secrets

| Where | What |
| --- | --- |
| Settings → Secrets | List by project with when and where each was set; Add, Replace and Delete. Values are never shown again. |
| `runpane secrets list [--project P] [--json]` | Project, name, updated time and machine. MCP: `secrets_list` in the `secrets` toolset. |
| `runpane secrets set --project P --name N --yes` | Reads the value from stdin only, so it never lands in your shell history or a process list. There is no MCP tool for it. |
| `runpane secrets delete --project P --name N --yes` | MCP: `secrets_delete` in the `secrets` toolset. |

A missing secret fails with `SECRET_NOT_FOUND` and the next step: request it, or
open Pane on a desktop connected to that machine so it syncs.

Secrets are managed on the machine itself: `runpane workspace <machine> secrets …`
is refused. From your own devices, run `runpane workspace <machine> exec -- runpane secrets …`
instead.

A project's environment variables can point at a Pane secret instead of holding
their own copy: see [Project environment variables](PROJECT_ENV_VARS.md).

## Where values are stored

| Host | Store |
| --- | --- |
| macOS | The login keychain: service `Pane` (or `Pane (<data directory>)` for a dev build's `PANE_DIR`), account `secret:<project>/<NAME>`. A value over 1 KB is kept in part items `secret:<project>/<NAME>#<id>.<n>`, which that account lists. |
| Windows, desktop Linux | `secrets.json` in the Pane data directory, mode 0600, each value encrypted with the OS (DPAPI, or the desktop keyring) through Electron's safeStorage |
| Linux without a keyring (a headless server) | The same 0600 file, as plain text. `runpane secrets list` on that host says so. |

The index of names, times and machines lives in `config.json` under `paneSecrets`.
A delete removes the stored value first. If the keychain refuses, the secret stays
saved and listed, and the delete can be run again once the keychain is unlocked.

## How secrets sync

Secrets travel with [shared integration keys](SHARED_CREDENTIALS.md), under the same
rules: a desktop or the phone that has more than one host saved carries them between
hosts, in memory. The copy set most recently wins, and a deletion is recorded so an
older copy cannot bring the secret back. Sync runs when a secret changes and when a
saved host reconnects. A host that was offline keeps its copy until a device that
carries keys reaches it. Hosts from before secrets ignore them.

## Who can read a secret

Any agent, and any program running as you, on any of your hosts, can use every Pane
secret. That is the point: agents keep and share their own secrets across projects.
The safeguards stop accidental exposure; they don't sandbox anything. Setting "Everyone on tailnet" on
any host gives everyone on the tailnet the same access.

| Who or where | Can read values? | Why |
| --- | --- | --- |
| Any agent or process running as you on a host | Yes | runpane's local socket is mode 0600 with no token. On macOS, items trust `/usr/bin/security`. |
| Every host Pane syncs to | Yes, holds a copy | Each saved host keeps a copy for offline use. |
| Your paired phone | Relays, never stores | The same rule as shared keys: a paired device can already open terminals on the host. |
| Teammates (other Tailscale logins on your tailnet), when any one of your hosts is set to "Everyone on tailnet" | Yes | Their `workspace exec` commands and the terminals they open there run as you, so they can read the keychain or `secrets.json`, run `runpane`, and reach every secret. Each synced host keeps a copy of your secrets, so that setting on any one host exposes them all. Pane refuses only their direct secret requests: secret cards, secret variables and [shared key sync](SHARED_CREDENTIALS.md), and their terminals start without secret variables. Keep "Only me" on every host unless you trust everyone on the tailnet with all your secrets. |
| A Linux host without a keyring | At rest in a 0600 file, unencrypted | `runpane secrets list` on that host says so. |
| Chat, MCP output, Notify history and broadcasts, push payloads, Pane logs, analytics, `sessions.db`, `config.json` | No | Pane never writes or returns a value to any of them. |
| An agent's transcript and Pane's saved terminal scrollback | Only if the agent prints it | `exec` puts the value in a child's environment; if that command echoes it, the output goes wherever its output goes. |
| Running processes | Yes, through the environment | `ps eww` shows a process's environment to the same user. |
