# Workspaces: reach all your machines with runpane

`runpane workspace` lets your own Macs, Windows PCs, and Linux machines read files, write files, run commands, and drive each other's Pane over the Tailscale network you already use. There is no SSH, no keys, and no pairing code: each request is trusted because Tailscale says it comes from your own login.

```
runpane workspace list
runpane workspace <machine> read  <path>
runpane workspace <machine> write <path>          # content from stdin
runpane workspace <machine> exec -- <command>     # runs in that machine's shell
runpane workspace <machine> <runpane command>     # e.g. sessions list --json
```

`<machine>` is the Tailscale machine name (`parsa-devbox`), a unique prefix (`devbox`), the MagicDNS name, or a Tailscale IP.

These commands ship in the npm CLI (`npm i -g runpane`, or `npx --yes runpane@latest workspace list`). The Python package prints the workspaces status block but does not run them.

`workspace <machine> <runpane command>` runs any command that talks to Pane, such as `sessions list`, `panes list`, or `workspace state`, against that machine's Pane. Commands that only make sense on the machine you type them on (`doctor`, `agent-context`, `mcp`, `docs`, `install`) are refused with the alternative: run them there with `runpane workspace <machine> exec -- 'runpane doctor'`.

## Turning it on

Workspaces are on by default. When Tailscale is installed and signed in, the desktop Pane that owns `~/.pane` joins your tailnet as it starts:

- It listens on `127.0.0.1` on a free port.
- It runs `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`, next to the remote daemon's port 443 handler if you have one.
- Nothing is opened to the public internet, and no firewall rule is added. Serve is reachable only inside your tailnet.

Every `runpane --help`, `runpane doctor`, and `runpane agent-context` prints the current state:

```
Workspaces: on (parsas-macbook-pro)
Other machines: parsa-devbox (Windows, online), parsas-macbook-air (macOS, offline)
Reach them: runpane workspace <machine> read|write|exec|<command>
```

When workspaces are off, the first line says why and gives the one step that fixes it:

| Reason | Fix |
|---|---|
| Tailscale is not installed | Install Tailscale from https://tailscale.com/download and sign in. |
| Tailscale is signed out | Open Tailscale and sign in. |
| This tailnet has HTTPS certificates turned off | Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns. |
| Pane is not running | Open Pane. |
| Turned off with `runpane workspace disable` | `runpane workspace enable` |

`runpane workspace disable` removes the 8443 handler and keeps this machine off until `runpane workspace enable`. This machine can still reach your other machines while it is off. A Pane started with a different data directory (`PANE_DIR` or `--pane-dir`) stays off unless you run `runpane workspace enable` against it.

Pane must be running on a machine for others to reach it. Pane checks Tailscale again every minute while it is off, so signing in to Tailscale after Pane starts is enough.

## Who is trusted

Only the machine owner's own Tailscale login is accepted. Pane learns the owner from the `Self` entry in `tailscale status --json`, and Serve adds a `Tailscale-User-Login` header to every request after removing any copy the caller sent.

- A device signed in as another Tailscale user, including a teammate's Mac shared into your tailnet, is refused.
- A tagged device is refused: Serve sends no identity for it.
- Pane answers only requests that arrive through Serve: Serve's target path carries a secret that changes every launch, and requests straight to the loopback port are refused. Another OS user on the same machine who can read `tailscale serve status` could learn it, so give other accounts on a joined machine only the trust you would give the owner.
- Browsers are refused. A web page open on one of your devices could otherwise send requests that Serve signs with your login.
- Any device signed in as you, your phone included, is trusted. `runpane workspace list` shows only Macs, Windows PCs, and Linux machines, but that is a listing choice, not a block.
- Removing a device from Tailscale revokes it everywhere.

## What `write` and `exec` can do

`write` and `exec` give your agents SSH-level control of every joined machine. A local agent's permission prompts and sandbox see only `runpane workspace ... exec`, not what runs on the other machine. Turn workspaces off on any machine that should not accept this.

## Hand a task to another machine

`runpane handoff` uses workspaces to move a task to a fresh agent on another of your machines. The sending agent writes a handoff note; the CLI checks it, makes sure the branch is pushed, and starts the agent there:

```
runpane handoff --template > ~/handoff.md                      # fill in every section
runpane handoff "claude opus on parsas-macbook-pro" --note-file ~/handoff.md --push
```

The destination machine needs Pane running, the repository saved in Pane with a remote for the same GitHub repository, and its own `runpane` on PATH (otherwise it uses `npx runpane@latest`). The note lands in that machine's `~/.pane/handoffs/`, the agent starts in a new Pane branched from your branch, and it reports back to your panel with `runpane workspace <your machine> panels submit`. The note's sections are in the `handoff` skill's [note template](../main/src/services/paneChatBundle/skills/handoff/references/note-template.md).

## Paths across Windows, WSL, and macOS

`read`, `write`, and `exec --cwd` take any path form and translate it on the machine that runs the request, so agents do not need `cat` on one machine and `Get-Content` on another:

- `C:\Users\me\notes.md` and `/mnt/c/Users/me/notes.md` reach the same Windows file.
- On Windows, WSL paths such as `/home/me/repo/README.md` are read through `\\wsl.localhost\<distro>\...` using the default distribution (the one `wsl -l -v` marks with `*`). Name another distribution with `\\wsl.localhost\<distro>\...`.
- Inside WSL, `C:\...` becomes `/mnt/c/...`, and runpane reads the tailnet from Windows' `tailscale.exe`.
- `~` is the home directory of the machine that runs the request.

`read` prints the file to stdout (`--json` returns `content` with `encoding` `utf8` or `base64`) and lists a directory's entries. `write` reads stdin, creates missing parent folders, and replaces the file. `exec` runs in the shell Pane uses for terminals there (Git Bash or PowerShell on Windows, your default shell elsewhere), prints its stdout and stderr, ends with a line naming the machine, OS, shell, and exit code, and exits with the command's exit code. `--json` returns all of these fields. Pass the command as one quoted string (`exec -- 'grep "a b" notes.md'`): several words after `--` are joined with spaces. A command that starts a background job returns when the shell exits, and `--timeout-ms` stops the whole process tree. If that tree cannot be stopped, the result says so (`stillRunning` in `--json`, "may still be running" in text).

## Without a machine name

With no `<machine>`, `read`, `write`, and `exec --cwd` route a path that cannot exist on this machine to the one joined machine it fits. `C:\...` on a Mac goes to your Windows machine; if several fit, runpane lists them and asks for a name. Any other path is this machine's: `read` and `write` hand it to this machine's Pane, so it follows the same rules as a named machine (`~`, directories, new parent folders), and Pane must be running here.

Other commands help in the same way. When a file such as a `--from-json` or `--prompt-file` path is missing and looks like another machine's path, the error names the likely machine and the exact `runpane workspace <machine> read` command. When a Session is not found here, runpane checks your other online machines and names the one that has it.

## Workspaces and pairing codes

Workspaces and the [self-hosted remote daemon](SELF_HOSTED_REMOTE_DAEMON.md) both use Tailscale Serve, for different jobs:

| | Workspaces | Pairing codes (remote daemon) |
|---|---|---|
| For | Your own machines, from the runpane CLI | Browsers, phones, desktop Pane, and other people's devices |
| Trust | Your Tailscale login | A `pane-remote://` code per device |
| Serves | The desktop Pane's `~/.pane` | The remote daemon's data directory, usually `~/.pane_remote` |
| Port | 8443 | 443 |
| Setup | None | `runpane setup` on the host, then paste the code |

Machine commands (`read`, `write`, `exec`) are served only to workspace identity, never to pairing tokens.

## Troubleshooting

- `runpane workspace list` shows each machine's state. "Pane is not answering there" means Pane is not running on that machine, its workspaces are off, or it runs a Pane version without workspaces.
- `tailscale serve status` should list `https://<machine>.<tailnet>.ts.net:8443` proxying to `http://127.0.0.1:<port>`.
- A Pane older than workspaces reports `Workspaces: off ... (this Pane is older than workspaces)`; update Pane.
