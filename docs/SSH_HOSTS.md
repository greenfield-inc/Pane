# SSH hosts

Pane lists the hosts in your SSH config under **SSH hosts** in the sidebar. Click one and Pane opens a terminal tab that runs `ssh <host>` with your own `ssh`, keys and `ssh-agent`. You need no project, and no coding agent starts.

## Add a host

Any `Host` entry in your SSH config shows up:

```
Host mini
  HostName 192.168.1.20
  User me
  IdentityFile ~/.ssh/id_ed25519
```

## Open a host

SSH tabs open in the **SSH view**, which takes the place of the main area, like Pane Chat.

- **Click a host** to show its tab. If the host has no tab yet, Pane opens one.
- **Right-click a host**, or hover it and click **+**, to open another tab on it.
- A dot beside a host means it has an open tab.
- With the sidebar collapsed to icons, the **SSH hosts** icon opens the SSH view. With no tab open, the view lists your hosts.

Each tab is an ordinary Pane terminal. Pane starts its default shell (**Settings → Terminal → Default shell**) in your home folder and types `ssh <host>` into it. Password, passphrase and host-key prompts appear in the tab as they would in any terminal. When the connection ends or fails, you are back at a local prompt. After Pane restarts, your SSH tabs return in the SSH view, and each one runs `ssh <host>` again the first time you open it.

## Which file Pane reads

| System | File |
| --- | --- |
| macOS, Linux | `~/.ssh/config` |
| Windows | `C:\Users\<you>\.ssh\config` |

Pane also reads the files that config pulls in with `Include`, the way `ssh` does: globs such as `Include conf.d/*` expand in sorted order, relative paths start from your `.ssh` folder, and `~` means your home folder. An `Include` counts only when it applies to every host: before the first `Host` or `Match` line, or under `Host *`. An `Include` inside a narrower `Host` or `Match` block applies only to that block's hosts, so `ssh` would not use its entries for a plain `ssh <host>`, and Pane does not list them. If a host from an included file is missing, move its `Include` line to the top of the config. Pane takes the home folder from your user account, as `ssh` does: on macOS and Linux changing `$HOME` does not move it, and on Windows it is the profile folder Windows records for your account.

Pane reads the files again on start, when its window comes back into focus, and when you expand the section. After editing the config in another app, switch back to Pane to see the change. After editing it in a Pane terminal, collapse and expand **SSH hosts**. A host you delete from the config stays in the list while it has an open tab, so you can return to that tab; it disappears once you close its tabs.

Pane opens only the config and its included files. It never opens, copies or uploads your keys; `ssh` reads them.

## Which hosts appear

Every name on a `Host` line appears, in file order, so `Host web db` lists both `web` and `db`. Hosts from an included file appear where its `Include` line is. A repeated name appears once. Pane skips:

- Patterns with `*`, `?` or `!`, such as `Host *` or `Host *.internal`.
- Names that do not start with a letter, digit or `_`, or that contain characters other than letters, digits and `. _ @ : -`. Pane types the name into a shell, so it lists only names every shell passes to `ssh` unchanged; a leading `-` would be an `ssh` option and a leading `@` means something else in PowerShell.
- Hosts that appear only in `Match` blocks, and the system-wide config (`/etc/ssh/ssh_config`, or `%ProgramData%\ssh\ssh_config` on Windows).

If a host is missing from the list, check it against these rules. A missing or unreadable config lists no hosts; an unreadable included file is skipped. With no hosts and no open SSH tabs, the section and its sidebar icon stay hidden.

## Windows

Pane's default shell on Windows is Git Bash when it is installed, otherwise PowerShell or `cmd`. Each shell runs the first `ssh` on its PATH: usually Git's `ssh` in Git Bash, and Windows' OpenSSH client in PowerShell and `cmd` (an optional Windows feature that recent versions install by default). Both read `C:\Users\<you>\.ssh\config`.

Windows' OpenSSH client refuses a private key that other accounts can read. Make the key readable only by you, replacing `id_ed25519` with your key file:

```powershell
icacls $env:USERPROFILE\.ssh\id_ed25519 /inheritance:r /grant:r "$($env:USERNAME):R"
```

## Remote Pane

When this window controls Pane on another machine through [Remote Pane](SELF_HOSTED_REMOTE_DAEMON.md), the list shows the hosts in that machine's SSH config, and `ssh` runs there with that machine's keys and network.

If a host runs Pane itself, connect to it with Remote Pane. That gives you its projects, files, dev servers at `localhost` and running agents.

The phone app shows no SSH host list.
