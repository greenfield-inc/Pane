# Add a device

Pair a phone, a browser or another computer with Pane, on any network. No
account, no Tailscale, no port forwarding.

Open **Add a device** from **Settings › Remote Access**, from **Add a
device…** in the sidebar's machine menu, or with **Pair a device** on Home,
which opens on the **Phone** tab. It has four tabs:

| Tab | What it does |
|---|---|
| **Phone** | Shows a QR code to scan with your phone. |
| **Computer** | Copies a one-time link for another computer, a phone or a browser, or takes a link copied on another computer. |
| **SSH** | Reaches a computer through your own SSH config and starts Pane there. See [SSH route](SELF_HOSTED_REMOTE_DAEMON.md#ssh-route). |
| **Wearables** | Shows a QR code that opens the glasses screen in the Pane phone app. |

## Pair a phone

1. On the computer, open **Add a device › Phone**.
2. Point your phone's camera at the code.
3. Tap the link. It opens the Pane app. Without the app, it opens a page that
   offers the App Store on an iPhone, and Pane in the phone's browser.

Get the iPhone app on the App Store: [Pane - Remote Coding Agents](https://apps.apple.com/app/id6808839038).
In the EU? [Get it on TestFlight](https://testflight.apple.com/join/eKJmnzXF) for now.

After installing it, go back to the pairing page and tap **Open in Pane app**,
or scan the code again. If the code expired, scan the new one in the dialog.
Send feedback on [Discord](https://discord.gg/BdMyubeAZn).

The phone shows the computer's sessions a few seconds later. A QR code works
once and expires after 10 minutes; the dialog shows a new one after each use.

Phone access is this computer's connection to Pane's relay, which phones,
browsers and links use. Opening the Phone or Computer tab turns it on. If you close it before a code ever appears (for example after "Can't reach ..."), Pane turns phone access
back off, so it doesn't keep retrying in the background.

Inside the Pane app you can also scan from **Settings › Add a machine**.
The app still accepts `pane-remote://` connection codes.

## Full access or Read only

The **Phone** and **Computer** tabs ask what the code or link gives whoever
uses it. The choice is saved with the code and is part of the sign-in token
the device gets, so it is fixed when the device pairs and travels with it on
every route.

| Access | What the device can do |
|---|---|
| **Full access** (selected) | Everything you can do there: type, run agents, approve, open files. For your own devices. |
| **Read only** | Sees Sessions, Panes, agent status, transcripts, terminal output, to-dos and loops, live. Can't type, run, approve, open files or see your keys. For a teammate. |

A read-only device sees everything your agents and terminals print, including
any key or password that appears on screen. Pane shows that text as it is.
These stay with you:

- launch commands, and the settings of repositories, Sessions and loops (scripts,
  prompts, profiles);
- in a chat, approvals and questions waiting on you, and prompts not sent yet;
- in a tab's state, everything except its kind, title, agent, status, report,
  folder and size;
- file, diff, browser and log tabs.

An agent's question that waits on you still shows in its to-do and in its report, as
the agent wrote it; you answer it on your own devices.

The computer checks each request, on every route. It answers the reads above
and refuses the rest with `ERR_READ_ONLY_ACCESS`: commands, files and media,
forwarded ports, dev server previews and dictation.

- **A phone or browser** that pairs Read only gets this computer and every
  computer linked with it, all read-only. Its other computers stay apart from
  yours.
- **A computer** that uses a read-only link watches this computer and the ones
  linked with it. The link runs one way: your computers get no route to that
  computer, and the two groups stay separate.
- **A linked computer on an older Pane** is skipped until it updates. Pair
  the device again after the update to add it.
- A computer that already has full access here refuses the read-only link and
  leaves it unused. To watch instead, unlink it first.

Whoever opens the link is asked at the level it shows, and pairs at that level.
If the sharing computer then answers with another one, nothing is linked
(`ERR_LINK_LEVEL_CHANGED`).

To change a device's access, remove it, then pair it again.

## Link another computer

1. On the first computer, open **Add a device › Computer**, pick the access and
   how long the link lasts (**Expires after**), and choose **Copy link**.
2. Send the link to the other computer and open it there in a browser. The
   page opens desktop Pane (**Open Pane**), which links the two.
   Or paste the link into **Add a device › Computer › Or finish here** on the
   other computer.
3. For a full-access link, the first computer shows **Linked with &lt;computer&gt;**. If you don't
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

A full-access link joins two groups of computers. Every computer in either group can
then reach every other one, on every route it has, and run agents there.
After that:

- a new phone that pairs with any one of them gets all of them, with the
  access it paired with;
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
to reach them from here. **Watching this computer** lists computers you gave
read-only access. **Settings › Remote Access › Phones and glasses**
lists phones and glasses.

A browser reaches the computer whose link it opened, plus the computers
already linked with it. A browser never links computers with each other: each
computer's browser app keeps its own list.

## When a link asks first

A computer always asks before it uses a link, unless it already reaches the
computer that made the link: once linked, that computer can run agents on it.
For a read-only link, the prompt says **Read only** and names the computers to
watch.
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
through a paired phone. This is full access; see
[Full access or Read only](#full-access-or-read-only) for what a read-only
device gets.

## Pair glasses

Glasses pair through the Pane phone app, with a computer the phone has full
access to. **Add a device › Wearables** shows a
QR code for `https://runpane.net/glasses` (your own relay's domain when you
run one). Scanning it with the phone opens **Settings › Glasses** in the Pane
app; without the app, the page says how to get it. See
[Even G2 glasses](EVEN_G2_GLASSES.md).

## Share a computer with a teammate

Choose **Read only** when you share with someone else. They, and their agents,
see what your agents are doing.

1. Open **Add a device**: **Phone** for their phone, **Computer** for a link.
2. Choose **Read only** and read the warning: they will see everything your
   agents and terminals print, including any key or password that appears on
   screen.
3. Send them the link, or let them scan the code.
4. Check the name of the device that paired, under **Phones and glasses** or
   **Watching this computer**. Remove a device you don't know.

On a linked computer, sharing covers the whole linked group: they can watch
every computer linked with this one. On their computer,
`runpane workspace <your computer> sessions overview --session <id>` and the
pane MCP read your Sessions. See
[A read-only computer](RUNPANE_WORKSPACES.md#a-read-only-computer).

Share **Full access** only with someone you trust to run anything as you, on
every computer linked with this one. Their phone can then do what yours does,
pairing glasses included, and once they confirm, it links this computer with
any computer it already paired.

## Remove a phone or a computer

- **Remove › Remove from &lt;this computer&gt;**, on a phone's row under
  **Phones and glasses**, signs it out of this computer only.
- **Remove from all your computers** signs it out everywhere. Its open
  connections close within seconds. The Pane app shows **Pair again**; a
  browser says the computer removed it and to scan a new code on that
  computer.
- **Remove**, on a read-only phone's row or a computer's row under **Watching
  this computer**, takes its read-only access back here and on every computer
  linked with this one. A linked computer that is asleep or offline is named.
  After it starts or wakes, it accepts the read-only tokens it handed out only
  once this computer confirms which devices it still shares with, so the
  removed device reaches nothing there even if it asks first. On a computer the
  device was handed on to, **Remove** asks the computer that shares it; when
  that one can't be reached, nothing is removed and Pane says which computer to
  remove it on. Pairing that device again needs a new code or link.
- Removing a phone also undoes the links it made: computers that phone linked
  stop reaching each other, along with the phones they shared it with. That
  keeps a lost or stolen phone from leaving a way back in. To link them again,
  pair one phone with each of them.
- **Unlink from all your computers**, in a linked computer's expanded row,
  removes that computer from every computer's and phone's list, and the
  phones you paired through it lose access to it. The other computers in the
  group stay linked with each other. A computer also on your
  tailnet stays as a Tailscale row.
- **Forget**, on a computer with no Pane relay route or one you watch read-only,
  removes it from this computer's list only.

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
  retrying while it is open, at least every 5 seconds (once a minute after an
  hour without reaching it); nothing to do. On the same Wi-Fi it connects
  directly even when the internet is down.
- **"&lt;computer&gt; hasn't said, since this computer started or woke, that it still shares with this device":**
  a read-only device reached a computer that was handed its token by another,
  which hasn't confirmed it since that computer started or woke. Wait until the
  computer that shared it is online, then reconnect.
- **"This … already has full access to &lt;computer&gt;":** a read-only link
  shares a computer this device reaches with full access. Remove that computer
  from the device first, then open the link again.
- **Removing a read-only device fails with "… which didn't answer":** it was
  handed its token by another computer, which is off. Wake that computer and
  remove it again, or remove it there.
- **"Asleep since 9:40":** the computer is asleep. Wake it, or turn on Keep
  Awake.
- **A browser on a Wi-Fi with no internet** can't reach the computer: a
  browser needs internet DNS. Open the Pane app instead.
- **"New pairings through Pane relay are paused until …":** each computer
  gets its own certificate, from Let's Encrypt or, when Let's Encrypt is
  turning new computers away, Google Trust Services. This shows only when both
  refuse. Until the time shown, Add a device grays out the QR code and the
  Computer link, and Remote Access › Phones and glasses says the same. Keep Add
  a device open and Pane asks again then, or connect with Tailscale now: **Set
  up Tailscale** opens Remote Access › Tailscale. Tailscale uses its own
  `ts.net` certificates, so the limit doesn't apply to it. A computer that
  already has its certificate is not affected; Remote Access › Phones and
  glasses › Certificate shows which CA issued it.
- **"Can't reach &lt;computer&gt;" on the phone right after scanning:** that
  computer didn't answer within 10 seconds. Check that the phone is online,
  then open **Add a device** on the computer: it shows a code once phones can
  reach it, or says why not.
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
