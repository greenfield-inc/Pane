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
2. In the Pane phone app, open **Settings › Glasses** and tap **Pair glasses**. The phone asks each
   of your computers for a one-time pairing secret and copies them as one code. The code works for
   10 minutes and only once per computer.
3. Tap **Open Even app**, open Pane there, and tap **Paste**, then **Connect**.
4. The glasses show **Pane · N computers**. Each computer now lists the glasses under
   **Settings › Remote Access › Devices**, named after your phone, with when they were last used.

To add a computer later, tap **Add computers** in Settings › Glasses and paste the new code the same
way. Computers that are offline are skipped and named on the screen.

### The Even app's origin

The Even app serves the glasses app from `http://127.0.0.1`, on a port it picks each time it starts.
Pane accepts that origin on any port, so there is nothing to allow. A computer running an older
Pane refuses it and the glasses show **Allow this app on the computer**: update Pane on that
computer. Allowing the origin on an older Pane lasts only until the Even app restarts on a new port.

## Use it

| Gesture | What it does |
|---|---|
| Swipe up / down | Move through a list, scroll a terminal half a page, or turn card pages |
| Press | Open or pick; in a terminal, open keys mode |
| Double press | Back; on the home page, exit the app |
| Hold, then release | Talk, then send at once: an answer on a card, input in a terminal |

In **keys mode** the gestures go to the terminal, one key at a time in the order you made them:
swipe sends ↑ or ↓, press sends Enter and goes back to the output, double press leaves without sending anything, and hold opens a short list with
Esc and Tab. You can't dictate in keys mode; leave it first.

- **Home** shows one card per page with a page counter, questions first and then done and info
  cards, newest first. The last page is **Open a Pane…**. With nothing waiting, home is one
  all-clear page.
- **A card** shows the asking Pane's last output lines (dimmed), the question, and the choices.
  A long question is cut at three lines; the **Read the whole question** row shows all of it.
- **Open a Pane…** lists your computers (live or offline), then that computer's Sessions and Panes
  in the Pane apps' order: pinned ones first, then Sessions, a blank line, then Panes, each newest
  first. A list longer than the 20 rows the glasses show ends in a **· N more ·** row that
  continues it from the first row left out. Picking one
  shows its live screen, refreshed about once a second, and marks the Pane viewed on that computer,
  as opening it there does. A stopped Pane starts its saved agent or command. The terminal hides an
  agent's input box and the status rows under it, so you read its output. Each swipe moves half a
  page: the half you just read stays on screen, dimmed. Swiping down to the end follows live again.
  Press opens keys mode, which shows the whole screen, input box included. The bottom line names
  the newest card from another Pane; double press goes to it.
- **Menus**: when a terminal shows a menu Pane is certain of (a list numbered from 1 at the bottom
  of the screen with exactly one cursor mark, such as `❯`, `>` or `›`, under a prompt whose top is
  on screen), its choices appear as a list, under the last two lines above it: the question and
  what it asks about, such as the command to run. Swipe to a choice and press: Pane waits for any
  keys you pressed before, reads the screen again, and presses the choice's number, which Claude
  Code and Codex take as that answer wherever the cursor is. If anything in the prompt changed
  between the list showing and that read (the question, any row of the command, or any choice),
  it sends nothing, says "The menu changed, so nothing was sent", and opens keys mode. A menu that
  changes after the read, while the number is on its way, can still receive it. A menu still on
  screen a second after its number ignores numbers: keys mode opens so you answer it with arrows
  and Enter. Double press dismisses the list. Any other prompt,
  including one taller than the screen, is answered from keys mode.
- **Going back** from a terminal or a computer's list opens the list on the row you picked. Native
  glasses lists always open on their first row, so the list starts there, runs to the end, then
  continues from the top after a **· top of the list ·** row.
- **Dictation** types what you said into the Pane and presses Enter right away. A misheard line
  typed into a shell runs, so check the Pane before you talk into a plain shell. After you send,
  the view holds at your line while the reply grows below it, and the top line counts the lines
  still below ("↓ 18 more"). Swipe down to read on; the last swipe follows live again. If your line
  leaves the screen (the agent cleared it) or a menu appears, the view goes back to live.
- **Keys need Pane on the computer to be up to date.** A computer on an older Pane refuses the
  first key, and the glasses say so: "<computer>'s Pane can't take keys from the glasses yet."
  Update Pane there. Dictation still works.

With the app closed, Pane's phone alerts still reach the glasses through the Even app's
notification mirroring, as the title only ("planner has a question").

## Revoke

- On the phone: **Settings › Glasses › Revoke Glasses** revokes them on every computer it can reach,
  and finishes the rest when they next answer.
- On a computer: **Settings › Remote Access › Devices**, then **Revoke** next to the glasses.

Revoking closes the glasses' connection to that computer within 5 seconds. A revoke sticks: your
other computers can't add the glasses back to this one. Pairing the glasses again from the phone
lifts the revoke on each computer it pairs.

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
  owner allowed in **Settings › Remote Access › Devices**, matched exactly except that a loopback
  origin matches on any port. Null, missing and wildcard origins are never accepted. A page served
  from `127.0.0.1` on your phone still needs a glasses token, which only the paired glasses hold.
- The source is not **locked out**: 5 refused attempts in 10 minutes lock it out for a minute,
  doubling on each repeat up to an hour. Each refusal is logged with the source and reason, never
  the token.

A glasses token reaches only what the glasses use: listing Sessions and Panes, reading and typing
into terminals, pressing one key at a time, dictation, and Notify. The keys are ↑, ↓, Enter, Esc,
Tab and the digits 1 to 9, one per request, and nothing else: text, two keys at once, Ctrl-C,
Ctrl-D, ← → and 0 are refused before they reach the terminal (`ERR_GLASSES_KEY_REFUSED`), logged
without the input, and not counted toward the lockout. These keys are enough to answer an agent's permission menu, so the
glasses can approve what an agent asks to do. Opening a stopped Pane restarts its saved agent or command,
in its own folder.

The token can also ask the computer to add these same glasses to your other computers. The
computer finds them with its own Tailscale discovery (your login only, never other people's or
tagged machines), skips any that already have the glasses, revoked them or have Funnel on, and
asks each of the others, as you, for a pairing secret for the glasses' own name and phone id (the id of
the phone that paired them). Each computer makes its own secret and issues its own token, so no
computer hands its tokens to another. Nothing in the request can pick the computers, the name or
the phone id, and the glasses may ask once
every 5 minutes. A password-protected computer is asked only when this computer has its password
saved; one whose Pane is too old to remember revokes is skipped.

The token cannot pair any other device, change settings, write files, commit, run machine commands,
or choose what a terminal runs, and its event stream never carries terminal output.

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
| Allow this app on the computer | Update Pane on that computer (see above). |
| Not paired, or revoked | Pair again from Settings › Glasses in the Pane phone app. |
| Locked out for N s | Wait. If you did not cause the refusals, revoke the glasses on that computer. |
| Funnel is on | On the computer, run `tailscale funnel reset`, or turn Funnel off for port 8443. |
| Can't turn speech into text | Add a Deepgram or fal key on that computer. |
| Deepgram rejected X's key, or X's Deepgram key isn't a valid key | On that computer, paste a current key from the Deepgram console in **Settings › Integrations › Voice transcription**. Pane checks it with Deepgram when you save. |
| Lost the connection to X while listening | Hold to talk again. If it keeps happening, check Tailscale on the phone. |

## For developers

The app lives in [`glasses/`](../glasses). Run the Even simulator against it and point a dev build of
Pane at it with `PANE_GLASSES_ORIGINS=http://localhost:5173` (an exact origin, comma separated for
several; a loopback one covers every port). The host side is `main/src/daemon/glassesAccess.ts`; the shared pairing-code format is
`shared/types/glasses.ts`.
