# Pair a phone with a QR code

Scan one code and use Pane from your phone, a phone's browser or another
computer, on any network. No account, no Tailscale, no port forwarding.

## Pair a phone

1. On the computer, open Pane. On **Home**, choose **Use Pane on your phone**
   (or **Settings › Remote Access › Devices › Pair a phone**).
2. Point your phone's camera at the code.
3. Tap the link. It opens the Pane app, or Pane in the phone's browser when
   the app is not installed.

The phone shows the computer's sessions a few seconds later. The code works
once and expires after 10 minutes; the dialog shows a new one after each use.

Inside the Pane app you can also scan from **Settings › Add a machine**.
The app still accepts `pane-remote://` connection codes.

## What works

Everything the Tailscale path does: terminals, agents and approvals, alerts
when an agent needs you, dev server previews and HTML files on the phone, and
the files in a worktree. Another computer reaches the same computer for
**Switch to**, forwarded ports and `runpane workspace`, and glasses pair
through a paired phone.

## How it connects

Each computer gets its own address, `https://<id>.runpane.net`, with its own
certificate. The computer holds the private key; it never leaves the
computer.

- **Same Wi-Fi:** the Pane app connects to the computer directly.
- **Anywhere else:** Pane's servers in the US, EU and Asia pass the encrypted
  connection along without reading it. The Pane app and desktop also find a
  direct internet path when both networks allow it, the way Tailscale does.

Pane's servers see which computer a connection is for, IP addresses, timing
and byte counts. They never see what you type, what your agents print, your
tokens or your pages. The Pane app and desktop also check each computer's key,
so a certificate issued for the same name to anyone else is refused.

## Your computers

Every computer the Pane app pairs with is linked to the other computers that
app has paired with, with no prompt. After that:

- a new phone that scans any one of them gets all of them;
- the computers list each other under **Switch to**, for ports and
  `runpane workspace`;
- alerts from any of them reach every phone.

**Settings › Remote Access › Devices** lists each phone and linked computer,
and says which phone linked a computer ("Linked by Ana's iPhone").

Scanning someone else's computer links it with yours, and theirs with yours.
Undo it with **Unlink from all your computers**.

Linking happens in the Pane app. A browser reaches the computer whose code
it scanned, plus the computers the Pane app already linked with it. Scanning
a second computer in a browser doesn't link the two: each computer's browser
app keeps its own list.

## Share a computer with a teammate

A teammate scans a fresh code from your computer, as you do. Their phone gets
its own sign-in, listed under **Devices** by its name, and can do what yours
does there, pairing glasses included. Because computers are linked, it also
reaches every computer linked with this one, and links this computer with any
computer their phone already paired. **Remove from Studio Mac** (the button names this computer) signs out
only their phone, only here; **Remove from all your computers** signs it out
of every computer it reached through yours.

## Remove a phone or a computer

- **Remove from Studio Mac** (the button names this computer) signs a phone out of this computer only.
- **Remove from all your computers** signs it out everywhere. Its open
  connections close within seconds. The Pane app shows **Pair again**; a
  browser says the computer removed it and to scan a new code on that
  computer.
- Removing a phone also undoes the links it made: computers that phone linked
  stop reaching each other, along with the phones they shared it with. That
  keeps a lost or stolen phone from leaving a way back in. To link them again,
  pair one phone with each of them.
- **Unlink from all your computers**, on a linked computer's row, removes
  that computer from every phone's list and from **Switch to** everywhere,
  and the phones you paired through it lose access to it.

## When something goes wrong

- **"This code was already used" or "This code expired":** scan the new code
  the computer shows.
- **"Can't reach <computer>. Retrying…":** the app keeps retrying while it is
  open; nothing to do. On the same Wi-Fi it connects directly even when the
  internet is down.
- **"Asleep since 9:40":** the computer is asleep. Wake it, or turn on Keep
  Awake.
- **A browser on a Wi-Fi with no internet** can't reach the computer: a
  browser needs internet DNS. Open the Pane app instead.
- **"Phones can't connect: this computer's phone listener isn't running":**
  another app (often a second Pane) holds the listener's port. Quit that app,
  or give the listener a free port in **Settings › Remote Access › More ›
  Advanced**. Until then the computer turns phones away.

## Use your own relay

Set **Settings › Remote Access › More › Relay address** to a relay you run,
and Pane connects there instead of Pane's servers. Computers link only with
computers on the same relay. See
[Run your own relay](SELF_HOSTED_RELAY.md).

## Use Tailscale instead

Tailscale keeps working as before: **Settings › Remote Access › More › Use
Tailscale instead**. See [Self-hosted remote daemon](SELF_HOSTED_REMOTE_DAEMON.md)
and [Workspaces](RUNPANE_WORKSPACES.md).
