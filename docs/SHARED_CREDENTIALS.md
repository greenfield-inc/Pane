# Shared integration keys

Set an integration key once and every Pane host you use gets it. A key set on your Mac reaches your Windows PC, and a key you type in the iPhone app reaches every host the phone has saved.

## Which keys

| Key | Where you set it |
| --- | --- |
| Deepgram, fal, OpenRouter (voice dictation) | Settings → Integrations on a desktop, or the phone's voice setup |
| APNs key for iPhone notifications | Settings → Integrations → iPhone notifications |
| Anthropic, OpenAI | `anthropicApiKey`, `openaiApiKey` in the host's `config.json` |

A key that exists only in a host's environment (for example `FAL_KEY` or the `PANE_APNS_*` variables) stays on that host and is never shared. On that host the environment value wins over a shared one.

## How keys travel

Hosts never contact each other on their own. A device that has more than one host saved, whether found over Tailscale or paired with a code, carries the keys between them:

- **The iPhone app** syncs whenever it opens or returns to the foreground, after you save a key from the phone, and when a host reports that its settings changed. It relays the keys and keeps no copy.
- **A desktop with another host saved** syncs when it starts, when a key changes on it, and when a saved host reports a change. Computers on your Tailscale login are saved the first time you switch to them, from the sidebar's machine menu or Settings → Remote Access → Switch to. To pair with a code instead, create a connection code on the other host (Settings → Remote Access → More → Set Up Host) and paste it under Settings → Remote Access → Switch to → Add a machine.

Sharing chains: if your Mac is paired with your Windows PC and the Windows PC with a Linux server, a key set on the Mac reaches the Linux server once both syncs have run.

When two hosts disagree, the copy that was set most recently wins. Removing a key records when you removed it, so an older copy on another host does not bring it back. Settings → Integrations shows which host each key was set on and when.

A host that is offline keeps its own copy and catches up on the next sync. Hosts running a Pane version from before key sharing are skipped.

## Who can read the keys

Only your own devices. Over Tailscale, a host answers a request for its keys only from its owner's Tailscale login, even when its workspace lets other people on the tailnet in, so a teammate's computer neither receives nor replaces your keys. With a connection code, the caller must present a valid pairing token, and the host refuses the request when it does not require pairing. Either device can already open terminals on that host, so sharing keys with it exposes nothing new.

Keys are never written to logs or events. They are stored in each host's `config.json` in the Pane data directory, as before.

## Stop sharing

Remove the host from the device, or unpair it. On a host, revoke it under Settings → Remote Access → Set Up This Machine → Host status. On a desktop, open the machine's details (i) in Settings → Remote Access and choose Forget. On the phone, remove the host. The keys already copied to each host stay there until you remove them, and removing a key on one host removes it from the others on the next sync.
