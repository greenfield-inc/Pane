# Workspaces: reach all your machines with runpane

`runpane workspace` lets your own Macs, Windows PCs, and Linux machines read files, write files, run commands, and drive each other's Pane over the Tailscale network you already use. There is no SSH, no keys, and no pairing code: each request is trusted because Tailscale says it comes from your own login.

```
runpane workspace list
runpane workspace <machine> read  <path>
runpane workspace <machine> write <path>          # content from stdin
runpane workspace <machine> exec -- <command>     # runs in that machine's shell
runpane workspace <machine> <any runpane command> # e.g. sessions list --json
```

`<machine>` is the Tailscale machine name (`parsa-devbox`), a unique prefix (`devbox`), the MagicDNS name, or a Tailscale IP.

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
- A process on the machine itself can reach the loopback port and set the header. That grants nothing new, because local processes already have the owner's access.
- Removing a device from Tailscale revokes it everywhere.

## What `write` and `exec` can do

`write` and `exec` give your agents SSH-level control of every joined machine. A local agent's permission prompts and sandbox see only `runpane workspace ... exec`, not what runs on the other machine. Turn workspaces off on any machine that should not accept this.

## Paths across Windows, WSL, and macOS

`read`, `write`, and `exec --cwd` take any path form and translate it on the machine that runs the request, so agents do not need `cat` on one machine and `Get-Content` on another:

- `C:\Users\me\notes.md` and `/mnt/c/Users/me/notes.md` reach the same Windows file.
- On Windows, WSL paths such as `/home/me/repo/README.md` are read through `\\wsl.localhost\<distro>\...` using the default distribution. Name another distribution with `\\wsl.localhost\<distro>\...`.
- Inside WSL, `C:\...` becomes `/mnt/c/...`.
- `~` is the home directory of the machine that runs the request.

`read` prints the file to stdout (`--json` returns `content` with `encoding` `utf8` or `base64`) and lists a directory's entries. `write` reads stdin, creates missing parent folders, and replaces the file. `exec` runs in the shell Pane uses for terminals there (Git Bash or PowerShell on Windows, your default shell elsewhere), prints its stdout and stderr, ends with a line naming the machine, OS, shell, and exit code, and exits with the command's exit code. `--json` returns all of these fields.

## Without a machine name

With no `<machine>`, `read`, `write`, and `exec --cwd` route a path that cannot exist on this machine to the one joined machine it fits. `C:\...` on a Mac goes to your Windows machine; if several fit, runpane lists them and asks for a name.

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
