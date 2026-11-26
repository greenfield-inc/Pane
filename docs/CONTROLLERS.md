# Game controllers

Pick up a game controller and drive Pane without a mouse or keyboard: move
around with the stick, open what needs you, hold a trigger to talk, and send.
The desktop app (macOS, Windows and Linux) and the phone app (Android and
iPhone) read Xbox, PlayStation and Switch-style pads while Pane is in front.

## Getting started

1. Pair or plug in the pad.
2. Bring Pane to the front and press any button. The first press after you
   install Pane shows the cheat sheet; it never shows on its own again.
3. Hold **−** (View, Select or Create on your pad) any time to see the cheat
   sheet again, and let go to close it.

A focus ring shows where you are while you use the pad. Touch the mouse or
keyboard and the ring hides; everything works as before.

## The buttons

Letters follow what is printed on your pad: **A** picks and **B** goes back on
every pad, wherever those letters sit. On a PlayStation pad, ✕ picks and ○
goes back.

| Button | What it does |
| --- | --- |
| Left stick, D-pad | Move focus. At the edge of the sidebar, a split or a panel, focus moves on to the next region. |
| D-pad in a terminal | Arrow keys to the agent (Claude Code menus, history). The left stick still moves focus. |
| A | Open or pick. In a terminal: Enter. |
| B | Back: close the open dialog, or go to the sidebar. |
| L1 / R1 | Previous or next tab, when you let go. |
| L1 + R1 held | Move focus to the other split, with no tab change. |
| L2 | Show or hide the sidebar. |
| L3 (click the left stick) | Search. |
| R2 held | Talk. Let go and the words go into the box, unsent. Hold again to add more. |
| Y | Send. In a terminal agent: Enter on its own. A pad that can rumble pulses when the message is sent. |
| X | Key pad: Esc, ^C, Tab and Shift+Tab for the terminal, picked with the D-pad and A. |
| Right stick | Scroll the focused tab. |
| R3 (click the right stick) | Jump to the bottom. |
| + | Open the next thing that needs you: questions oldest first, then permissions, then Panes waiting in their terminal. |
| − | Search, on its Recent list. Hold: the cheat sheet. |

Home, Guide, PS and Capture are left to your OS. Approvals have no single
"approve" button: you move to the option you want and press A, the same as a
click, so a stray press can't approve. A press within a quarter second of an
approval opening is ignored, so the press that opened it can't answer it.

Every action is also a command in **Settings › Shortcuts** under
**Controller**, with no key by default, so you can give any of them a
keyboard key.

## Talking with R2

Holding R2 uses the same dictation as the phone app: Deepgram live
transcription, or a recorded clip sent to fal, with the optional OpenRouter
cleanup. Add a key in **Settings › Integrations**; until then, holding R2 says
so and offers the button.

The words go into the box you are in: the chat tab's message box, the search
field, an answer box, or a terminal agent's input line, typed as a paste with
no Enter. Press Y to send.

### Microphone permission

- **macOS:** the first hold asks for microphone access. If you said no, allow
  Pane in **System Settings › Privacy & Security › Microphone**, then hold
  again.
- **Windows:** allow desktop apps in **Settings › Privacy & security ›
  Microphone**.
- **Linux:** Pane uses the default input device. If none is found, Pane says
  so.

## Button letters

Pane reads the pad's family from what it reports (its USB vendor, or its name)
and shows that family's letters on the cheat sheet. Some pads pretend to be
another brand, such as a Switch-style pad in Xbox mode. Fix the letters in
**Settings › Shortcuts › Game controller › Button letters**: Auto, Xbox,
PlayStation or Nintendo.

### Pad modes

- **CRKD Atom and Atom+:** in Pro Controller (Switch) mode, Pane shows
  Nintendo letters, so the right button, printed A, picks. In its Xbox mode the
  pad reports itself as an Xbox controller: set Button letters to Nintendo to
  match what is printed. In its XInput mode, holding the D-pad and − for five
  seconds swaps A and B on the pad itself.
- **8BitDo:** S (Switch) mode reports as a Pro Controller and shows Nintendo
  letters. X (XInput) mode reports as Xbox; set Button letters to Nintendo.
  D (DirectInput) and A (Apple) modes depend on the pad; switch to S or X mode
  if the cheat sheet says Pane can't read it.

A pad the OS has no layout for shows "Pane can't read this controller's
layout" on the cheat sheet and drives nothing. Switch it to its Xbox or Switch
mode.

## Platform notes

- **Steam on Windows:** Steam Input can hide pads from other apps while Steam
  runs. Turn off Steam Input for the pad, or quit Steam, if Pane sees nothing.
- **Linux and Nintendo pads:** Switch Pro Controllers need read access to their
  `hidraw` device. Most distributions grant it through the `steam-devices` or
  `game-devices-udev` udev rules package.
- **Switch 2 pads** aren't read on desktop yet.
- Pane reads the pad only while its window is focused and visible, and does no
  work while no pad is connected.

## On the phone

The Android and iPhone apps follow the same scheme, with a phone's screens in
place of the sidebar. They need app version 1.6 or later (runtime 1.6): older
builds ignore the pad.

1. Pair the pad with the phone in its Bluetooth settings.
2. Open Pane and press any button. The cheat sheet shows once, with the pad's
   name and the letters Pane picked for it. Touch the screen and the ring
   hides until the next press.

What differs from desktop:

- **B** goes back a screen; on a Pane or Session it goes to Home.
- **L2** shows or hides Home's column on a tablet or an unfolded phone, and
  goes to Home on a phone.
- **−** opens Recent as a sheet. **L3** opens Home's search.
- **R2** dictates into the terminal's box, a chat tab's box, a question's
  answer box, or search, using the computer's voice keys like the mic button.
- In a split (an unfolded phone or a tablet), **L1 + R1** moves to the other
  column and the right stick scrolls only the focused one.
- **Settings › General › Controller** holds Button letters (Auto, Xbox,
  PlayStation, Nintendo), Show cheat sheet, and a link here.
- On Android, the Shortcuts, Attach, Voice setup and Copy sheets are separate
  windows Pane can't read the pad in: there B closes the sheet and the D-pad
  moves Android's own focus.
- On iPhone, **Home** opens Apple's Games app unless you add Pane under the
  pad's Home Button settings. Pane leaves it alone.

## For contributors

The scheme lives in `shared/controller/`: family profiles, the interpreter
(holds, chords, stick repeat), the binding table, the direction picker and the
Needs-you order. The desktop adapter and overlays are in
`frontend/src/controller/`, the phone's in `native/src/features/controller/`
with its native module in `native/modules/pane-controller` (see
[native/README.md](../native/README.md#game-controllers)). The scheme table above is checked against
`shared/controller/bindings.ts` by `frontend/src/controller/sharedController.test.ts`.
