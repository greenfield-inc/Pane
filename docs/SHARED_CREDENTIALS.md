# Shared integration keys

Set an integration key once and every Pane host you use gets it. A key set on your Mac reaches your Windows PC, and a key you type in the iPhone app reaches every host the phone is paired with.

## Which keys

| Key | Where you set it |
| --- | --- |
| Deepgram, fal, OpenRouter (voice dictation) | Settings → Integrations on a desktop, or the phone's voice setup |
| APNs key for iPhone notifications | Settings → Integrations → iPhone notifications |
| Anthropic, OpenAI | `anthropicApiKey`, `openaiApiKey` in the host's `config.json` |

A key that exists only in a host's environment (for example `FAL_KEY` or the `PANE_APNS_*` variables) stays on that host and is never shared. On that host the environment value wins over a shared one.

## How keys travel

Hosts never contact each other on their own. A device that is paired with more than one host carries the keys between them:

- **The iPhone app** syncs whenever it opens or returns to the foreground, after you save a key from the phone, and when a host reports that its settings changed. It relays the keys and keeps no copy.
- **A desktop paired with another host** syncs when it starts, when a key changes on it, and when a paired host reports a change. To pair, create a connection code on the other host (Settings → Remote Access → Set Up This Machine) and paste it under Settings → Remote Access → Your computers → Add with a Code.

Sharing chains: if your Mac is paired with your Windows PC and the Windows PC with a Linux server, a key set on the Mac reaches the Linux server once both syncs have run.

When two hosts disagree, the copy that was set most recently wins. Removing a key records when you removed it, so an older copy on another host does not bring it back. Settings → Integrations shows which host each key was set on and when.

A host that is offline keeps its own copy and catches up on the next sync. Hosts running a Pane version from before key sharing are skipped.

## Who can read the keys

Only devices you paired. A host answers a request for its keys only when the caller presents a valid pairing token, and refuses it when the host does not require pairing. A paired device can already open terminals on that host, so sharing keys with it exposes nothing new.

Keys are never written to logs or events. They are stored in each host's `config.json` in the Pane data directory, as before.

## Stop sharing

Unpair the device. On a host, revoke it under Settings → Remote Access → Set Up This Machine → Host status. On a desktop, delete the saved profile under Connections. On the phone, remove the host. The keys already copied to each host stay there until you remove them, and removing a key on one host removes it from the others on the next sync.
