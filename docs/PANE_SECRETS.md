# Pane secrets

Pane secrets are named values, such as API keys, that any agent on your machines can
use without the value showing up in chat. A secret is addressed as
`<project>/<NAME>`: the agent picks the project (`stripe`, `qa`, a repo's name) and
the name follows environment-variable rules, so it can be injected as-is.

A secret is one of two kinds:

| Kind | Where the value lives | Who sets it |
| --- | --- | --- |
| Typed | Saved in Pane on every host it syncs to, until you replace or delete it. | You in Settings → Secrets, an agent with `runpane secrets set`, or you on a `secrets request` card. |
| From 1Password | 1Password. Pane keeps only the reference, `op://vault/item/field`, and holds the value only during a [lease](#leases) you approve. | Only you, in Settings → Secrets. |

Values stay in the OS store, never in `config.json`, the database, logs, chat or MCP
output.

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

A secret from 1Password works the same way while it has a live lease on that
machine. Without one, `exec` runs nothing and fails with `SECRET_LEASE_ENDED`; its
next step is the command to ask for a lease.

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

## Secrets from 1Password

### Add a reference

In Settings → Secrets, choose **Add from 1Password**, then give the project, the
name and the reference. To get the reference, open the item in 1Password and choose
**Copy Secret Reference** on the field. It looks like `op://Dev/Stripe/secret key`.

Pane refuses a reference that contains `$`, braces or a line break.

Agents can't add or change a reference. `runpane secrets set` on a name that comes
from 1Password fails with `SECRET_IS_REFERENCE`.

### Move a typed secret to 1Password

**Move to 1Password** on a typed secret writes its value into 1Password, turns the
secret into a reference to that new item, and deletes the typed copies on every
host. The first move asks which vault to use; later moves use the same vault.

## Leases

A secret from 1Password has no value on any machine until you approve a lease.

### Asking for one

An agent asks with `runpane secrets lease` (MCP: `secrets_lease`):

```sh
runpane secrets lease --project stripe STRIPE_LIVE_KEY WEBHOOK_KEY --reason "Run the webhook tests."
```

One card shows:

- the names and their 1Password references
- the machines that will hold the values: by default your desktop and the machine
  the agent runs on
- the length and the time the lease ends

Your desktop decides the length. A card on another machine shows the length that
desktop will grant; a card from a headless host shows no length until a desktop
shows it.

Press **Start lease** on your computer. Pane reads 1Password once, which asks for
Touch ID or Windows Hello, and sends the values to each machine on the card. The
agent gets back the lease id, end time and machines, never a value:

```text
Leased stripe/STRIPE_LIVE_KEY, WEBHOOK_KEY until 2026-11-05T12:00:00.000Z on studio, devbox. Lease 3f9a2c1b7d4e8f06. Use them with `runpane secrets exec --project stripe -- <command>`.
```

**Decline** ends the card and the agent reads "The person declined the lease."

Only you approve a lease, and only on a computer, since only a computer can show
1Password's prompt. Agents can ask for a lease and end one, never grant or extend
one. Autopilot and teammates can't answer a lease card. The phone shows the card,
says to approve it on your computer, and can Decline.

You can also start a lease yourself in Settings → Secrets.

### Machines

A machine shared with "Everyone on tailnet" can't receive a lease: its teammates'
commands run as you there and could use it. Switching a machine to that setting ends
its leases at once, and it refuses to read leased values while the setting is on.
Settings → Secrets shows why a machine can't take one (that sharing, an offline
machine, or a Pane too old for leases).

A machine refuses a lease longer than 7 days.

Removing a saved computer ends the leases pushed to it if it is online; otherwise
they last until they expire there. Removing a desktop's link on a host ends the
leases that desktop pushed to it.

### Length and renewal

A lease lasts 24 hours by default. Change the length per project in Settings →
Secrets, from 1 hour to 7 days.

About an hour before a lease ends (a quarter of its length for leases shorter than
4 hours), Pane shows an **Extend** card. Extending reads 1Password again; ignored,
the lease ends on time and the card closes.

### Ending a lease

Settings → Secrets lists the live leases on each machine, with **End now** for one
and **End all**. An agent can end a lease it no longer needs:

```sh
runpane secrets lease end --id 3f9a2c1b7d4e8f06 --yes
```

When a lease ends, on time or early, each machine deletes its copy of the values.
After that, `secrets exec` and project variables can't read them. A command that is
already running keeps the environment it started with, and Pane can't take a value
back from a process, a file it wrote, or a transcript it printed to.

If Pane was closed when a lease expired, it deletes the values the next time it
starts.

### Machines without an OS keyring

A Linux machine with no keyring can't encrypt at rest, so it holds a lease in memory
only. The lease ends there if Pane restarts. The card and Settings → Secrets say when
a machine holds a lease in memory.

When the desktop reconnects to a machine, it sends a lease again only if that
machine held it in memory and lost it, or missed a renewal (including one it already
deleted at the old end while it slept). A lease an agent ended
on a machine stays ended.

### Lease log

Every lease event (granted, renewed, ended, expired, swept) adds one JSON line to
`secret-leases.log` in the Pane data directory. A line names the lease, project,
secrets and machine, never a value. The live lease records are in
`secret-leases.json` in the same directory, also without values.

Leases never travel with [shared key sync](SHARED_CREDENTIALS.md). A lease reaches a
machine only when you start it.

## Manage secrets

| Where | What |
| --- | --- |
| Settings → Secrets | Typed secrets and references by project, with when and where each was set; Add, Add from 1Password, Replace, Move to 1Password and Delete; live leases per machine with End now and End all; lease length per project. Values are never shown again. |
| `runpane secrets list [--project P] [--json]` | Typed secrets with their updated time and machine, then references with when their lease ends, such as `stripe/STRIPE_LIVE_KEY  from 1Password (op://Dev/Stripe/live key)  leased until <time>` or `no lease`. MCP: `secrets_list` in the `secrets` toolset. |
| `runpane secrets set --project P --name N --yes` | Reads the value from stdin only, so it never lands in your shell history or a process list. There is no MCP tool for it. |
| `runpane secrets delete --project P --name N --yes` | MCP: `secrets_delete` in the `secrets` toolset. |
| `runpane secrets lease --project P NAME...` | Asks for a lease on a card. MCP: `secrets_lease`, in the default toolset. |
| `runpane secrets lease end --id ID --yes` | Ends a lease on this machine. MCP: `secrets_lease_end` in the `secrets` toolset. |

Secrets are managed on the machine itself: `runpane workspace <machine> secrets …`
is refused. From your own devices, run `runpane workspace <machine> exec -- runpane secrets …`
instead.

A project's environment variables can point at a Pane secret instead of holding
their own copy: see [Project environment variables](PROJECT_ENV_VARS.md).

## Errors

| Code | What happened | Next step |
| --- | --- | --- |
| `SECRET_NOT_FOUND` | No secret by that name on this machine. | Request it, or open Pane on a desktop connected to that machine so it syncs. |
| `SECRET_UNREADABLE` | Pane could not read a stored value (a typed secret or a leased one), for example because the keychain is locked. | Unlock the login keychain (macOS). Otherwise set a typed secret again with `runpane secrets set`, or end the lease in Settings → Secrets and run `runpane secrets lease --project <p> <NAME>`. |
| `SECRET_LEASE_ENDED` | The secret comes from 1Password and has no live lease on this machine. Nothing was run. | Run `runpane secrets lease --project <p> <NAME...>`, and the person approves it on the card, or run with `--only` and the typed names you need. |
| `SECRET_IS_REFERENCE` | `secrets set` named a secret that comes from 1Password. Nothing was changed. | Run `runpane secrets lease --project <p> <NAME>` to use it, or remove the reference in Settings → Secrets first. |
| `SECRET_NOT_REFERENCE` | A lease named a secret that is not a 1Password reference on this computer. Nothing was leased. | Add it in Settings → Secrets with **Add from 1Password**, then start the lease again. |
| `SECRET_LEASE_NEEDS_DESKTOP` | A lease was started somewhere other than Pane on a computer, such as the phone or a headless host. Nothing was leased. | Press **Start lease** on the card in Pane on your Mac or PC. |
| `SECRET_LEASE_REFUSED` | A machine on the lease refused it or could not be reached, for example because it is shared with "Everyone on tailnet". Nothing was stored there, and a lease the asking machine could not take ends everywhere. | Set that machine to "Only me" in Settings → Workspaces, or lease without it. |
| `SECRET_LEASE_STARTING` | **Start lease** was pressed again while 1Password was still asking. Nothing else was sent. | Approve or dismiss the 1Password prompt. |
| `SECRET_REMOTE_ONLY` | A program on the machine itself called a channel only a paired desktop may use (pushing leases, key sharing). Nothing was changed. | Start or end leases from Settings → Secrets on your desktop, or run `runpane secrets lease`. |
| `ONEPASSWORD_CLI_MISSING` | Pane could not find the 1Password CLI (`op`), or it has no account to use. Nothing was read. | Install the 1Password CLI, and in the 1Password app turn on Settings › Developer › Integrate with 1Password CLI. |
| `ONEPASSWORD_NOT_APPROVED` | 1Password did not allow the read, for example because the prompt was dismissed. Nothing was read. | Unlock 1Password and approve its prompt (Touch ID or Windows Hello), then try again. |
| `ONEPASSWORD_FAILED` | The 1Password CLI failed, timed out waiting for approval, or answered in a form Pane does not recognize. | Unlock 1Password, check the reference (Copy Secret Reference), and check that the CLI is installed and up to date. |
| `SECRET_LEASE_UNSUPPORTED` | `secrets lease end` reached a Pane from before leases. | Update Pane. |
| `SECRET_OWNER_REQUIRED` | A teammate's command asked for a secret. | The owner does it on their own devices. |

## Where values are stored

| Host | Typed secrets | Lease values |
| --- | --- | --- |
| macOS | The login keychain: service `Pane` (or `Pane (<data directory>)` for a dev build's `PANE_DIR`), account `secret:<project>/<NAME>`. A value over 1 KB is kept in part items `secret:<project>/<NAME>#<id>.<n>`, which that account lists. | The same keychain service, one item per leased name, deleted when the lease ends. |
| Windows, desktop Linux | `secrets.json` in the Pane data directory, mode 0600, each value encrypted with the OS (DPAPI, or the desktop keyring) through Electron's async safeStorage API | The same file, encrypted the same way, deleted when the lease ends. |
| Linux without a keyring (a headless server) | The same 0600 file, as plain text. `runpane secrets list` on that host says so. | Memory only, never on disk. |

The index of names, times and machines lives in `config.json` under `paneSecrets`,
and references under `paneSecretReferences`. A delete removes the stored value first. If the keychain refuses, the
secret stays saved and listed, and the delete can be run again once the keychain is
unlocked.

## How secrets sync

Typed secrets and references travel with [shared integration keys](SHARED_CREDENTIALS.md),
under the same rules: a desktop or the phone that has more than one host saved
carries them between hosts, in memory. The copy set most recently wins, and a
deletion is recorded so an older copy cannot bring the secret back. Sync runs when a
secret changes and when a saved host reconnects. A host that was offline keeps its
copy until a device that carries keys reaches it. Hosts from before secrets ignore
them.

A reference syncs, but its value never does: only a lease you start sends values,
and only to the machines on its card. An older host or phone ignores references and
never receives a lease value.

## Who can read a secret

Any agent, and any program running as you, on any of your hosts, can use every typed
Pane secret, and every secret from 1Password while its lease is live on that host.
That is the point: agents keep and share their own secrets across projects. The
safeguards stop accidental exposure; they don't sandbox anything. Setting "Everyone
on tailnet" on any host gives everyone on the tailnet the same access to typed
secrets.

| Who or where | Can read values? | Why |
| --- | --- | --- |
| Any agent or process running as you on a host | Yes | runpane's local socket is mode 0600 with no token. On macOS, items trust `/usr/bin/security`. |
| Every host Pane syncs to | Typed secrets: yes, holds a copy. From 1Password: only during a lease that names that host. | Each saved host keeps a copy of typed secrets for offline use. |
| Your paired phone, with full access | Relays, never stores | The same rule as shared keys: a paired device can already open terminals on the host. It never receives a lease value. |
| A device or computer paired [Read only](QR_PAIRING.md#full-access-or-read-only) | Only what appears on screen | The host refuses it every secret request, shared key sync, file and command. It sees your agents' transcripts and terminal output, so a value an agent or terminal prints reaches it. Launch commands, repository scripts and prompts, Session and loop settings, waiting approvals and unsent prompts are left out of what it sees. |
| Teammates (other Tailscale logins on your tailnet), when any one of your hosts is set to "Everyone on tailnet" | Typed secrets: yes. From 1Password: no, since that host can't receive a lease. | Their `workspace exec` commands and the terminals they open there run as you, so they can read the keychain or `secrets.json`, run `runpane`, and reach every typed secret. Each synced host keeps a copy of your typed secrets, so that setting on any one host exposes them all. Pane refuses only their direct secret requests: secret and lease cards, secret variables, chat tab keys, chat tab sign-in and [shared key sync](SHARED_CREDENTIALS.md), and their terminals and chat tabs start without secret variables or chat tab keys, including after the owner switches one of their terminals to chat. Keep "Only me" on every host unless you trust everyone on the tailnet with all your typed secrets. |
| A Linux host without a keyring | Typed secrets at rest in a 0600 file, unencrypted. Lease values in memory only. | `runpane secrets list` on that host says so. |
| Chat, MCP output, Notify history and broadcasts, push payloads, Pane logs (including the lease log), analytics, `sessions.db`, `config.json` | No | Pane never writes or returns a value to any of them. |
| An agent's transcript and Pane's saved terminal scrollback | Only if the agent prints it | `exec` puts the value in a child's environment; if that command echoes it, the output goes wherever its output goes. |
| Running processes | Yes, through the environment | `ps eww` shows a process's environment to the same user, and a process keeps it after a lease ends. |
