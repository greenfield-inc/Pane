# Deploy Pane's relays

Pane's relays give every computer an address at `<id>.runpane.net`, so the
desktop app's "Pair a phone" QR code works on any network. Three relays run on
Google Compute Engine in the project `pane-pwa-preview`: `us` (us-central1),
`eu` (europe-west1) and `asia` (asia-southeast1). `us` and `eu` also answer DNS
for `runpane.net` (`ns1`, `ns2`). Each relay gets and renews its own Let's
Encrypt certificate, and sends Android alerts as the service account
`pane-push-sender` with no key file.

The desktop app connects to these relays as soon as a release with QR pairing
ships. **Deploy and verify the relays before tagging that desktop release.**
Merging the PR to `main` does not release the desktop app.

## What each step needs

| Step | Needs | On this Mac (2026-11-14) |
| --- | --- | --- |
| Buy `runpane.net` (two years, for the Public Suffix List) | A registrar account and payment | Not bought |
| Name servers and glue at the registrar | Registrar access after purchase | Not set |
| Public Suffix List entry for `runpane.net` | A pull request to publicsuffix/list, plus a `_psl` TXT record | Not submitted |
| Run `relay-deploy.yml` | GitHub repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT` (exist), plus `PANE_RELAY_ACME_EMAIL`, `PANE_RELAY_APNS_KEY_ID`, `PANE_RELAY_APNS_TEAM_ID`, `PANE_RELAY_ANDROID_CERT_SHA256` (to add) | Deploy variables exist; the four relay variables are missing |
| Create the VMs, addresses, firewall and uptime checks | The deploy service account needs `roles/compute.admin`, `roles/secretmanager.admin`, `roles/monitoring.editor`, `roles/serviceusage.serviceUsageAdmin`, and `roles/iam.serviceAccountUser` on `pane-push-sender` | Not checked: reading IAM needs a fresh `gcloud` sign-in |
| Three e2-small VMs and three static IPv4 addresses | Billing on `pane-pwa-preview`, about $45 to $55 a month | Not created |
| Store the APNs key in Secret Manager (once) | The Pane app's `.p8` key, and `gcloud` signed in as `parsa@dcouple.ai` | The key file is on this Mac (`PANE_APNS_KEY_PATH`); the `gcloud` sign-in has expired |
| Android app links (`assetlinks.json`) | The SHA-256 of the Play app signing certificate (Play Console › App integrity) | Not on this Mac |
| iOS universal links | Team id and bundle id `com.dcouple.pane.mobile` | Team id is on this Mac (`PANE_APNS_TEAM_ID`) |
| Android alerts | `pane-push-sender` with Firebase Cloud Messaging send rights (has it today) | Exists |

## Steps

1. **Buy the domain** and keep the registrar page open for step 5.
2. **Add the repository variables** above (GitHub › Settings › Secrets and
   variables › Actions › Variables). None of them is a secret.
3. **Store the APNs key once**, from a Mac that has it:

   ```sh
   gcloud auth login parsa@dcouple.ai
   gcloud --account=parsa@dcouple.ai --project=pane-pwa-preview \
     secrets create pane-relay-apns-key --data-file="$PANE_APNS_KEY_PATH"
   ```

4. **Run the workflow** "Deploy Pane relays" with `apply` off and read the
   printed plan, then run it again with `apply` on. It builds the relay image,
   pushes it to Artifact Registry, and runs
   [`deploy.sh`](deploy.sh): APIs, the registry secret, the firewall rule
   `pane-relay` (TCP 443, UDP and TCP 53, UDP 7842), one static address and
   one VM per region, and an uptime check on each `/healthz`. It prints the
   two name server addresses at the end.
5. **At the registrar**, set the name servers to `ns1.runpane.net` and
   `ns2.runpane.net` with glue records for the two printed addresses.
6. **Wait for DNS**, then check:

   ```sh
   dig +short NS runpane.net
   dig +short us.relay.runpane.net @ns1.runpane.net
   curl https://us.relay.runpane.net/healthz
   curl https://runpane.net/v1/relays
   curl https://runpane.net/.well-known/apple-app-site-association
   ```

   Each relay requests its certificate once DNS answers; `/healthz` answers
   over https within a few minutes.
7. **Submit the Public Suffix List entry** (publicsuffix/list pull request
   with a `_psl.runpane.net` TXT record pointing at it). Until it is listed,
   all computers share Let's Encrypt's weekly limit of 50 new certificates
   per registered domain; ask Let's Encrypt for a rate limit increase if
   sign-ups outpace it.
8. **Release the desktop app** through the normal [stable release](../../RUNBOOK.md#stable-release),
   then pair a phone with a QR code against production
   ([QR pairing](../../docs/QR_PAIRING.md)).

## Update or roll back

Rerun the workflow with `apply` on from the commit to deploy: it pushes
`pane-relay:<commit>` and restarts each VM on it. Computers reconnect on their
own within 30 seconds. To roll back, run it from the earlier commit.

## Watch

- Uptime checks `pane-relay-us`, `-eu`, `-asia` in Cloud Monitoring.
- Logs: `gcloud compute ssh pane-relay-us --zone us-central1-a -- docker logs pane-relay`.
  They show ids, IP addresses, byte counts and close reasons, never payloads.
- Block a computer: add its id to the blocklist file and pass `--blocklist`
  (see [relay/README.md](../README.md)).
