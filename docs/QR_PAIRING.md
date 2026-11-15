# Add a device

Pair a phone, a browser or another computer with Pane, on any network. No
account, no Tailscale, no port forwarding.

Open **Add a device** from **Settings › Remote Access**, from **Add a
device…** in the sidebar's machine menu, or with **Pair a phone** on Home. It
has four tabs:

| Tab | What it does |
|---|---|
| **Phone** | Shows a QR code to scan with your phone. |
| **Computer** | Copies a one-time link for another computer, a phone or a browser, or takes a link copied on another computer. |
| **SSH** | Reaches a computer through your own SSH config and starts Pane there. See [SSH route](SELF_HOSTED_REMOTE_DAEMON.md#ssh-route). |
| **Wearables** | Shows a QR code that opens the glasses screen in the Pane phone app. |

## Pair a phone

1. On the computer, open **Add a device › Phone**.
2. Point your phone's camera at the code.
3. Tap the link. It opens the Pane app, or Pane in the phone's browser when
   the app is not installed.

The iPhone app is in TestFlight. To get it, ask to join on
[Discord](https://discord.gg/BdMyubeAZn); the dialog and the pairing page
link there.

The phone shows the computer's sessions a few seconds later. A QR code works
once and expires after 10 minutes; the dialog shows a new one after each use.

Phone access is this computer's connection to Pane's relay, which phones,
browsers and links use. Opening the Phone or Computer tab turns it on. If you close it before a code ever appears (for example after "Can't reach ..."), Pane turns phone access
back off, so it doesn't keep retrying in the background.

Inside the Pane app you can also scan from **Settings › Add a machine**.
The app still accepts `pane-remote://` connection codes.

## Link another computer

1. On the first computer, open **Add a device › Computer**, pick how long the
   link lasts under **Expires after**, and choose **Copy link**.
2. Send the link to the other computer and open it there in a browser. The
   page opens desktop Pane (**Open Pane**), which links the two.
   Or paste the link into **Add a device › Computer › Or finish here** on the
   other computer.
3. The first computer shows **Linked with &lt;computer&gt;**. If you don't
   know that computer, choose **Not you? Unlink &lt;computer&gt;**. That undoes
   the link: your computers and the ones it brought stop reaching each other,
   and each group stays as it was before.

On a computer with no screen, run `runpane link '<link>'` instead. It asks
before linking (see [When a link asks first](#when-a-link-asks-first)); in a
script, pass `--yes`.

Both computers need Pane open with phone access on, and the same relay.
Opening **Add a device › Computer** on each turns phone access on. The same
link also works on a phone or in a browser, as a QR code does.

A link works once. It expires after the time chosen when it was copied:

| Made from | Expires after |
|---|---|
| **Add a device › Phone** (QR code) | 10 minutes |
| **Add a device › Computer** (copied link) | 10 minutes, 1 hour (the default) or 24 hours |

## Your computers

Linking joins two groups of computers. Every computer in either group can
then reach every other one, on every route it has, and run agents there.
After that:

- a new phone that pairs with any one of them gets all of them;
- each computer lists the others in **Settings › Remote Access › Computers**
  and the sidebar's machine menu, for ports and `runpane workspace`;
- alerts from any of them reach every phone.

A phone that already reaches computers links them with the new computer's
group when it pairs, after asking (below).

**Settings › Remote Access › Computers** shows each computer once, with a
pill for every route Pane can reach it on and a dot on the route in use.
Expand a row to see its routes in order, drag them to reorder, add one with
**Add route** (it opens **Add a device › Computer**), and see who linked it ("Linked by Ana's iPhone"). **Also linked** lists
computers that reach this one but that this one doesn't list; link them back
to reach them from here. **Settings › Remote Access › Phones and glasses**
lists phones and glasses.

A browser reaches the computer whose link it opened, plus the computers
already linked with it. A browser never links computers with each other: each
computer's browser app keeps its own list.

## When a link asks first

A computer always asks before it uses a link, unless it already reaches the
computer that made the link: once linked, that computer can run agents on it.
A phone or browser asks when it already reaches computers and the link comes
from a computer it doesn't reach yet. A phone or browser that reaches no
computers yet pairs without asking, since pairing gives it access and nothing
back. The prompt names the computers on both sides. The link's computer sends
its own list, so that list never skips the prompt.

This holds on desktop Pane, the phone app, a browser and `runpane link`.
**Not mine, cancel** links nothing, and the link stays unused for another
device until it expires.

## Routes

Pane reaches each computer by up to five routes, tried nearest first:

| Route | How Pane gets it |
|---|---|
| **Same network** | The computer reports its private addresses. Pane tries one only when it is on a subnet of the computer trying it, so another home network or a WSL, Docker or VM adapter costs no wait. |
| **Tailscale** | Both computers are on your tailnet. See [Workspaces](RUNPANE_WORKSPACES.md). |
| **SSH** | **Add a device › SSH**. See [SSH route](SELF_HOSTED_REMOTE_DAEMON.md#ssh-route). |
| **Public URL** | The computer has its own HTTPS address. See [Public URL](SELF_HOSTED_REMOTE_DAEMON.md#public-url). |
| **Pane relay** | A link or QR code. Pane's servers pass the connection along. |

Each computer reports its own routes when Pane connects to it, and Pane saves
them as "found automatically" when they are `https:` addresses. A link's
credential works on every route, so a found route needs no new pairing.

Each route proves it reaches the right computer its own way. Pane relay and
Same network routes check the computer's own key. A Tailscale route relies on
Tailscale's device identity, and a Public URL route on its HTTPS certificate:
Tailscale and your proxy end the encrypted connection with their own
certificates, so the computer's key never reaches the other side there. An SSH
route relies on SSH's host key check.

Pane connects on the first route that answers. When the connection goes
silent for 8 seconds, Pane checks the other routes and moves to the first that
answers, before the connection banner appears and without closing your Panes.
When none answers, Pane reconnects as it always does, after 12 seconds without
a heartbeat. While
on a farther route, Pane checks the nearer ones every minute, and when the
network changes or the computer wakes, and moves back to the first that
answers.

## How the relay connects

Each computer gets its own address, `https://<id>.runpane.net`, with its own
certificate. The computer holds the private key; it never leaves the
computer.

- **Same Wi-Fi:** the Pane app and desktop Pane connect to the computer
  directly.
- **Anywhere else:** Pane's servers in the central and western US, the EU
  and Asia pass the encrypted connection along without reading it. The Pane
  app and desktop also find a direct internet path when both networks allow
  it, the way Tailscale does.

Pane's servers see which computer a connection is for, IP addresses, timing
and byte counts. They never see what you type, what your agents print, your
tokens or your pages. On the relay, the Pane app and desktop also check each
computer's key, so a certificate issued for the same name to anyone else is
refused.

## What works

Everything the Tailscale path does: terminals, agents and approvals, alerts
when an agent needs you, dev server previews and HTML files on the phone, and
the files in a worktree. Another computer reaches the same computer for
switching to it, forwarded ports and `runpane workspace`, and glasses pair
through a paired phone.

## Pair glasses

Glasses pair through the Pane phone app. **Add a device › Wearables** shows a
QR code for `https://runpane.net/glasses` (your own relay's domain when you
run one). Scanning it with the phone opens **Settings › Glasses** in the Pane
app; without the app, the page says how to get it. See
[Even G2 glasses](EVEN_G2_GLASSES.md).

## Share a computer with a teammate

A teammate scans a fresh code from your computer, as you do. Their phone gets
its own sign-in, listed under **Phones and glasses** by its name, and can do
what yours does there, pairing glasses included. Because computers are linked,
it also reaches every computer linked with this one, and, once they confirm,
links this computer with any computer their phone already paired.
**Remove › Remove from &lt;this computer&gt;** signs out only their phone,
only here; **Remove from all your computers** signs it out of
every computer it reached through yours.

## Remove a phone or a computer

- **Remove › Remove from &lt;this computer&gt;**, on a phone's row under
  **Phones and glasses**, signs it out of this computer only.
- **Remove from all your computers** signs it out everywhere. Its open
  connections close within seconds. The Pane app shows **Pair again**; a
  browser says the computer removed it and to scan a new code on that
  computer.
- Removing a phone also undoes the links it made: computers that phone linked
  stop reaching each other, along with the phones they shared it with. That
  keeps a lost or stolen phone from leaving a way back in. To link them again,
  pair one phone with each of them.
- **Unlink from all your computers**, in a linked computer's expanded row,
  removes that computer from every computer's and phone's list, and the
  phones you paired through it lose access to it. The other computers in the
  group stay linked with each other. A computer also on your
  tailnet stays as a Tailscale row.
- **Forget**, on a computer with no Pane relay route, removes it from this
  computer's list only.

## When something goes wrong

- **"This code was already used" or "This code expired":** scan the new code
  the computer shows, or copy a new link.
- **"Phone access is off on this computer":** on the computer that opens the
  link, open **Add a device › Computer** once, then open the link again.
- **"&lt;computer&gt; is already linked here with a different key":** that
  computer was reinstalled. Unlink it, then copy a new link.
- **"&lt;computer&gt; uses the relay … and this computer uses …":** set both
  computers to the same relay.
- **"Reconnecting to &lt;computer&gt;…":** every route failed. The app keeps
  retrying, at least every 5 seconds, while it is open; nothing to do. On the
  same Wi-Fi it connects directly even when the internet is down.
- **"Asleep since 9:40":** the computer is asleep. Wake it, or turn on Keep
  Awake.
- **A browser on a Wi-Fi with no internet** can't reach the computer: a
  browser needs internet DNS. Open the Pane app instead.
- **"Phones can't connect: this computer's phone listener isn't running":**
  another app (often a second Pane) holds the listener's port. Quit that app,
  or give the listener a free port in **Settings › Remote Access › Tailscale ›
  Advanced**. Until then the computer turns phones away.

## Use your own relay

Run a relay on your own machine and domain in a few minutes with Docker
([Run your own relay](SELF_HOSTED_RELAY.md)), then set **Settings › Remote
Access › Phones and glasses › Relay address** to its domain. Pane connects
there instead of Pane's servers, and everything above works the same, on the
same Wi-Fi and from anywhere. Computers link only with computers on the same
relay.

## Tailscale

Tailscale is one of the routes. **Settings › Remote Access › Tailscale** sets
who can connect over it, a password, hosts and connection codes. See
[Workspaces](RUNPANE_WORKSPACES.md) and
[Self-hosted remote daemon](SELF_HOSTED_REMOTE_DAEMON.md).
