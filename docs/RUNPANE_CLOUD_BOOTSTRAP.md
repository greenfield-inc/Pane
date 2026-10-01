# Runpane Cloud sandbox bootstrap

`runpane cloud new` turns a fresh cloud sandbox into a paired Pane remote host. The provisioning
code lives in `packages/runpane/src/cloud/bootstrap/` and is provider-neutral: the provider adapter
hands it a `SandboxHandle` (run a bash script, write a file), and bootstrap does the rest.

## What `provisionSandbox()` does

Each step runs `rp-bootstrap.sh <step>` inside the sandbox and returns one `RP_RESULT <json>` line.
The script and the golden scrub/check scripts are embedded in the package
(`generated/assets.ts`, regenerated from `assets/*.sh` by `scripts/generate-cloud-assets.js`).

1. **Identity reset.** Forks restore onto pre-booted machines, so boot-time units never run. A
   sandbox whose `~/.runpane-cloud/session-id` names another Session is scrubbed with
   `golden-scrub.sh` and gets a fresh machine-id and SSH host keys. Re-running for the same Session
   is a no-op.
2. **Tailscale install** when the image lacks it; `tailscaled` is started.
3. **Strip-list check** (`golden-check.sh fork`): no agent, git, npm, Docker or browser
   credentials, no shell history, no Pane pairing state, no inherited Tailscale node. Provisioning
   stops if any item fails.
4. **Tailnet join** with a single-use, pre-authorized, `tag:rp-session` auth key minted through the
   Tailscale OAuth client. The key reaches the sandbox as a file in the 0700 state directory and is
   shredded after `tailscale up --hostname=rp-<id> --ssh=false`. Bootstrap refuses a node with
   Tailscale SSH on, a missing tag, or a suffixed name. A stale `tag:rp-session` device under the
   same hostname is deleted through the API first; otherwise the new node would join as `rp-<id>-1`.
   Runpane never deletes a device it did not create: if an untagged (member) or differently tagged
   device holds the name, the join stops and names it.
5. **Pane daemon.** With Pane on disk (the golden image, or a `.deb` bootstrap installs and checks
   against a sha256), bootstrap runs `pane --remote-setup --prefer-tunnel tailscale` directly.
   Otherwise it runs `runpane install daemon --format deb --prefer-tunnel tailscale`. The node's
   operator is set to the login user so setup can run `tailscale serve`.
6. **Pairing.** The `pane-remote://` code goes to `~/.runpane-cloud/pairing.code` (0600) in the
   sandbox and to the caller's local file (0600). It is redacted from every log and never printed.
   `extraClients` adds further paired clients, such as the coordinator's.
7. **Optional repo clone** over public HTTPS. The sandbox holds no GitHub credentials.
8. **Readiness.** `GET https://<MagicDNS name>/health` over the tailnet must report ready. The
   first request waits for Tailscale Serve's first TLS certificate, which takes about 30–40 s.

## Repair: `reenrolSandbox()`

Tailscale identity survives a stop and resume, so re-enrolment is a repair path only. It deletes
the old device (the recorded node, and `tag:rp-session` devices under the hostname) through the API first, wipes `tailscaled.state`, rejoins with a new single-use key
under the same hostname, and restores the Serve mapping, which lives in the wiped state. The MagicDNS
name and the pairing stay the same; the tailnet IPs change.

## Golden images

A golden image is a boat named snapshot of a plain sandbox with the Pane `.deb` installed (unpaired),
Tailscale installed (not joined) and Playwright Chromium in `/opt/ms-playwright`. After installing those, run
`golden-scrub.sh` and then `golden-check.sh golden` on it, and save the snapshot only if the check passes.
Never `mv` files into kept paths while building: files moved in from `~/.cache` or `/tmp` arrive empty on
forks.
