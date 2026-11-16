# Passwords in browser tabs

Pane's browser tabs have no password manager built in, and browser extensions
don't run in them. To sign in to a page beside your agent:

- **Open in your browser.** The address bar's **Open in your browser** button
  (the arrow out of a box, after Copy URL) opens the page in your default
  browser, where your password manager's extension already works. On a
  desktop connected to a remote host, it opens the address this computer
  reaches the host's port at.
- **Use your password manager's desktop app.** Some fill the focused field in
  any app, including a Pane browser tab.

## Desktop apps and Pane tabs

What each app offers, from its own documentation. None of these has been
tested with Pane yet.

| Password manager | macOS | Windows | Linux |
|---|---|---|---|
| 1Password 8 | Universal Autofill: click the field, press `⌘\` | Auto-Type: click the username field, press `Ctrl+Shift+Space`, pick the login | Copy and paste from Quick Access |
| Bitwarden | Copy and paste | Auto-type, where your account has it | Copy and paste |
| KeePassXC | Global Auto-Type | Global Auto-Type | Global Auto-Type (X11; Wayland asks you to pick the entry) |
| NordPass | Copy and paste | Copy and paste | Copy and paste |

- **1Password on macOS** (untested with Pane) needs the Accessibility
  permission (System Settings › Privacy & Security › Accessibility). 1Password treats Pane as an app, not a
  browser, so it doesn't see which site the tab shows. The first time, it asks
  whether the login may fill in Pane: choose **Always Allow** to link that
  login to Pane, or **Allow Once**. See 1Password's
  [Universal Autofill guide](https://support.1password.com/mac-universal-autofill/).
- **1Password on Windows**: turn on Auto-Type in Settings › General. See
  [Auto-Type](https://support.1password.com/windows-auto-type/).
- **Bitwarden and KeePassXC** match a login to the focused window's title, and
  Pane's window title doesn't include the tab's site. Match the login to Pane
  instead: in KeePassXC, give the entry the window title pattern `*Pane*`.
  Bitwarden's Windows auto-type is still rolling out; see Bitwarden's release
  notes for how it matches.
- **NordPass** fills only in browsers and mobile apps
  ([NordPass help](https://support.nordpass.com/hc/en-us/articles/360003613497-How-does-autofill-work)).

Filling inside the tab from a password manager's extension is tracked in
[#1442](https://github.com/greenfield-inc/Pane/issues/1442).
