# SSH hosts

Pane lists the hosts in your SSH config under **SSH hosts** in the sidebar. Click one and Pane opens a terminal tab that runs `ssh <host>` with your own `ssh`, keys and agent. It needs no project and starts no coding agent.

## Open a host

- **Click a host** to open its tab in the SSH view. If the host already has a tab, Pane switches to it.
- **Right-click a host**, or hover it and click **+**, to open another tab on the same host.
- A dot beside a host means it has an open tab.
- With the sidebar collapsed to icons, the **SSH hosts** icon opens the SSH view. With no tab open, the view lists your hosts.

Each tab is an ordinary Pane terminal. Pane starts your usual shell in your home folder and types `ssh <host>` into it, so when the connection ends you are back at a local prompt. After Pane restarts, your SSH tabs come back and connect again when you open them.

## Which file Pane reads

| System | File |
| --- | --- |
| macOS, Linux | `~/.ssh/config` |
| Windows | `C:\Users\<you>\.ssh\config` |

Pane also reads every file that config pulls in with `Include`, the way `ssh` does: globs such as `Include conf.d/*` expand in alphabetical order, relative paths start from your `.ssh` folder, and `~` means your home folder. Pane reads the home folder from your user account, as `ssh` does, so changing `$HOME` does not move it.

Pane reads the file again whenever it shows the list: on start, when the window comes back into focus, and when you expand the section. Add, rename or remove a `Host` and the list follows without a restart. A tab that is already open stays open after you delete its host.

Pane never opens, copies or uploads your keys. It reads only the config files, and `ssh` does the rest.

## Which hosts appear

Every name on a `Host` line appears, in file order, so `Host web db` lists both `web` and `db`. Pane skips:

- Patterns with `*`, `?` or `!`, such as `Host *` or `Host *.internal`.
- Names with characters other than letters, digits and `. _ @ : -`. Pane types the name into a shell, so it never lists a name a shell could misread.
- Hosts that appear only in `Match` blocks, and the system-wide `ssh_config`.

With no config file, or no concrete hosts in it, the section stays hidden.

## Windows

Pane runs `ssh` in its default shell: Git Bash when it is installed, otherwise PowerShell or `cmd`. Choose another under **Settings → Terminal → Default shell**. Git Bash uses Git's `ssh` and PowerShell uses Windows' own OpenSSH client; both read `C:\Users\<you>\.ssh\config`.

Windows OpenSSH refuses a private key that other accounts can read. Make the key readable only by you:

```powershell
icacls $env:USERPROFILE\.ssh\id_ed25519 /inheritance:r /grant:r "$($env:USERNAME):R"
```

## Remote Pane

When this Pane is connected to another Pane through [Remote Pane](SELF_HOSTED_REMOTE_DAEMON.md), the list shows the hosts in that machine's SSH config, and `ssh` runs there with that machine's keys and network.

If a host runs Pane itself, connect to it with Remote Pane instead of SSH. You get its projects, files, dev servers at `localhost` and running agents, not only a shell.
