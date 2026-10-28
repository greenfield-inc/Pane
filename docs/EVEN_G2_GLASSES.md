# Use Pane from Even G2 glasses

The Pane glasses app runs on [Even Realities G2](https://www.evenrealities.com) glasses, inside the
Even Realities phone app. It shows every Pane Notify card from all your computers, lets you answer
with the R1 ring or your voice, and opens any Pane's live terminal so you can read it and dictate
into it.

It talks straight to each of your computers over Tailscale. Pane has no relay.

## What you need

- G2 glasses (the R1 ring is optional; the temple touchpads do the same gestures).
- The Even Realities app on your phone, and the Pane app ([iOS and Android](NATIVE_MOBILE.md)).
- Tailscale on the phone and on each computer, signed in with the same login.
- Pane open on each computer, with **Settings › Remote Access › Who can connect** set to
  **Only me** or **Everyone on tailnet** (on by default for the Pane that owns `~/.pane`).
- For dictation and voice answers, a Deepgram key (live) or a fal key (recorded) on the computer
  you talk to: **Settings › Integrations › Voice transcription** on the computer, or **Settings › Voice** in the
  Pane phone app.

## Install and pair

1. In the Even Realities app, open **Even Hub** and install **Pane**.
2. In the Pane phone app, open **Settings › Glasses** and tap **Pair Glasses**. The phone asks each
   of your computers for a one-time pairing secret and copies them as one code. The code works for
   10 minutes and only once per computer.
3. Tap **Open Even App**, open Pane there, and tap **Paste**, then **Connect**.
4. The glasses show **Pane · N computers**. Each computer now lists the glasses under
   **Settings › Remote Access › Glasses**, named after your phone, with when they were last used.

To add a computer later, tap **Add Computers** in Settings › Glasses and paste the new code the same
way. Computers that are offline are skipped and named on the screen.

### The Even app's origin

The Even app serves the glasses app from `http://127.0.0.1`, on a port it picks each time it starts.
Pane accepts that origin on any port, so there is nothing to allow. A computer running an older
Pane refuses it and the glasses show **Allow this app on the computer**: update Pane there, or allow
the origin under **Settings › Remote Access › Glasses**.

## Use it

| Gesture | What it does |
|---|---|
| Swipe up / down | Move through a list, scroll a terminal, or turn card pages |
| Press | Open or pick; in a scrolled-up terminal, jump back to live |
| Double press | Back; on the home page, exit the app |
| Hold, then release | Talk, then send at once: an answer on a card, input in a terminal |

- **Home** shows one card per page with a page counter, questions first and then done and info
  cards, newest first. The last page is **Open a Pane…**. With nothing waiting, home is one
  all-clear page.
- **A card** shows the asking Pane's last terminal lines (dimmed), the question, and the choices.
  A long question is cut at three lines; the **Read the whole question** row shows all of it.
- **Open a Pane…** lists your computers (live or offline), then that computer's Sessions and Panes.
  Picking one shows its live screen, refreshed about once a second. Swipe up for earlier output.
  The bottom line names the newest card from another Pane; double press goes to it.
- **Dictation** types what you said into the Pane and presses Enter right away. A misheard line
  typed into a shell runs, so check the Pane before you talk into a plain shell.

With the app closed, Pane's phone alerts still reach the glasses through the Even app's
notification mirroring, as the title only ("planner has a question").

## Revoke

- On the phone: **Settings › Glasses › Revoke Glasses** revokes them on every computer it can reach,
  and finishes the rest when they next answer.
- On a computer: **Settings › Remote Access › Glasses**, then the trash button next to the glasses.

Revoking closes the glasses' connection to that computer within 5 seconds.

## Security

The glasses app is a web page inside the Even app. Each computer lets it in only when all of these
hold:

- The request comes through Tailscale Serve on your tailnet with **your** Tailscale login. Other
  people on your tailnet are refused even with a valid glasses token. Funnel is never used: while
  Funnel is on for the computer's workspace port, glasses are refused.
- It carries this computer's **glasses token**: 256 random bits, one per pair of glasses, stored on
  the computer only as a hash. Tokens travel only in the `Authorization` header (and the voice
  WebSocket's subprotocol), never in a URL.
- It comes from an **allowed origin**: the Even app's `http://127.0.0.1` on any port, or one the
  owner allowed in **Settings › Remote Access › Glasses**, matched exactly except that a loopback
  origin matches on any port. Null, missing and wildcard origins are never accepted. A page served
  from `127.0.0.1` on your phone still needs a glasses token, which only the paired glasses hold.
- The source is not **locked out**: 5 refused attempts in 10 minutes lock it out for a minute,
  doubling on each repeat up to an hour. Each refusal is logged with the source and reason, never
  the token.

A glasses token reaches only what the glasses use: listing Sessions and Panes, reading and typing
into terminals, dictation, and Notify. It cannot pair other devices, change settings, write files,
commit, or run machine commands, and its event stream never carries terminal output.

Typing into a terminal can run commands, so treat the glasses like your phone: whoever holds a
working token on your tailnet and login can type into your shells. The Even app serves the glasses
app's code, so a compromised Even build could read the token on your phone; revoke the glasses if
you lose the phone, and check **Last used** on each computer.

The pairing code on your clipboard holds one-time pairing secrets, not tokens, and expires after
10 minutes.

## Troubleshooting

| On the glasses | Fix |
|---|---|
| Can't reach any computer | Turn Tailscale on in the phone's Tailscale app. The glasses reconnect on their own. |
| Allow this app on the computer | Update Pane on that computer, or allow the shown origin there (see above). |
| Not paired, or revoked | Pair again from Settings › Glasses in the Pane phone app. |
| Locked out for N s | Wait. If you did not cause the refusals, revoke the glasses on that computer. |
| Funnel is on | On the computer, run `tailscale funnel reset`, or turn Funnel off for port 8443. |
| Can't turn speech into text | Add a Deepgram or fal key on that computer. |

## For developers

The app lives in [`glasses/`](../glasses). Run the Even simulator against it and point a dev build of
Pane at it with `PANE_GLASSES_ORIGINS=http://localhost:5173` (an exact origin, comma separated for
several; a loopback one covers every port). The host side is `main/src/daemon/glassesAccess.ts`; the shared pairing-code format is
`shared/types/glasses.ts`.
