# App Review information

Paste the **Notes** section into App Store Connect > App Review Information > Notes (4,000 bytes max). The rest is for whoever prepares the submission.

## Before submitting

Fill in these fields in App Store Connect. None of them belong in this repo.

| Field | Value |
| --- | --- |
| Sign-in required | Yes. The app has no accounts, but it does nothing until it pairs with a Pane host. |
| User name | `n/a` (write "No account; see notes") |
| Password | `n/a` |
| Contact | A Dcouple person who can restart the review host during review |
| Connection code | A fresh `pane-remote://` code for the review host, pasted into the notes at submission time |

The review host must stay online, reachable over HTTPS, for the whole review. A computer running Pane desktop (Mac, Windows or Linux) on Tailscale Serve or behind an HTTPS proxy works, because non-loopback hosts must use HTTPS. Seed it with one repository and two or three panes, including one running an agent, so the reviewer sees real output. Generate the connection code with `setupRemoteHostCli` (see `native/README.md`, "Point it at a host"). The code is a credential for that host, so revoke it once the review ends.

## Notes

```text
Pane is the phone companion to Pane, a free, open-source desktop app for Mac, Windows and Linux (runpane.com) that runs AI coding agents in terminals on the user's own computer. This app pairs with the user's computer and lets them watch and answer those agents from their phone. There are no accounts and no Dcouple servers. The phone talks only to the computer it paired with.

HOW TO REVIEW
1. Open the app and tap "Connect with a code".
2. Paste this code into the Connection Code field, then tap "Import & Connect":
   <PASTE CONNECTION CODE HERE>
3. The home screen lists the panes (agent workspaces) on our review computer. Tap one to open its live terminal.
4. Type in the prompt box at the bottom and tap Send, or use the quick keys (Esc, Tab, Enter, arrow keys). The text goes to the agent on the computer.
5. Tap the microphone to dictate a prompt instead of typing. Tap it again to stop.
6. Tap + on the home screen to start a new pane.

The review computer stays online during review. If it is unreachable, contact us and we will restart it.

PERMISSIONS
- Camera: used only to scan the pairing QR code that the desktop app shows. Pasting the code works without the camera.
- Microphone: used only for dictation, from the moment the user taps the microphone until they tap it again (60 seconds at most). Audio goes to the user's own paired computer, which transcribes it. Nothing is recorded in the background.
- Notifications: the paired computer sends a push when an agent needs input or finishes a turn. The app asks for permission only after pairing, and only when the computer has push set up.
- Local network: the app can connect to a Pane host on the same machine or local network. It uses no background modes.

The terminal view is a bundled local page that renders the agent's text output. It does not browse the web.
```

## Capabilities, for the submitter

| Capability | Where it is declared | Why |
| --- | --- | --- |
| Camera | `expo-camera` plugin in `native/app.json` | Scans the pairing QR code. |
| Microphone | `expo-audio` plugin in `native/app.json` | Voice dictation, streamed to the paired host. |
| Push notifications | `expo-notifications`, production APNs entitlement | Alerts when an agent needs input or finishes. The host sends them. |
| Local networking | `NSAllowsLocalNetworking` in `native/app.json` | Allows plain HTTP to loopback and local hosts. Remote hosts must use HTTPS. |
| Background modes | None | The app does not run in the background. No background audio. |
| Encryption | `ITSAppUsesNonExemptEncryption: false` | Uses only HTTPS and OS cryptography. |

The app sets no `NSLocalNetworkUsageDescription`. iOS asks for local network permission only when the app pairs with a LAN IP address. Tailscale and loopback hosts don't trigger the prompt. If review pairs over a LAN address and the prompt appears without a description, add one before submitting.

## Review risks

These are tracked for the public release in [Pane#744](https://github.com/greenfield-inc/Pane/issues/744). The listing uses what exists today.

- **Pairing (4.2.3).** The app does nothing until it pairs with a Pane host. The reviewer needs the live host and connection code above. The listing and notes say plainly that Pane pairs with the desktop app.
- **Privacy policy text.** runpane.com/privacy covers the desktop app and doesn't mention the iOS app. A reviewer may ask about it.
- **Trademarks (2.3.7).** The name, subtitle and keywords don't use Claude, Codex, or other third-party names. The screenshots show a real Claude Code session inside the terminal, as the app shows it.
