# Deploy Pane's relays

Pane's relays give every computer an address at `<id>.runpane.net`, so the
desktop app's **Add a device** QR code works on any network. Four relays run on
Google Compute Engine in the project `pane-pwa-preview`: `us` (us-central1),
`eu` (europe-west1), `asia` (asia-southeast1) and `west` (us-west1).
To add one, add a line to `RELAYS` in `deploy.sh` and its region to
`PANE_RELAYS` in `main/src/daemon/relay/relayService.ts`. `us` and `eu` also answer DNS
for `runpane.net` (`ns1`, `ns2`). Each relay gets and renews its own Let's
Encrypt certificate, sends Android alerts as the service account
`pane-push-sender` with no key file, and with the same account mints the
one-time Google Trust Services EAB keys computers use when Let's Encrypt turns
them away.

The desktop app connects to these relays as soon as a release with QR pairing
ships. **Deploy and verify the relays before tagging that desktop release.**
Merging the PR to `main` does not release the desktop app.

## What each step needs

| Step | Needs |
| --- | --- |
| Buy `runpane.net` (two years, for the Public Suffix List) | A registrar account and payment |
| Name servers and glue at the registrar | Registrar access after purchase |
| Public Suffix List entry for `runpane.net` | A pull request to publicsuffix/list, plus a `_psl` TXT record |
| Run `relay-deploy.yml` | GitHub repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `PANE_RELAY_ACME_EMAIL`, `PANE_RELAY_APNS_KEY_ID`, `PANE_RELAY_APNS_TEAM_ID` and `PANE_RELAY_ANDROID_CERT_SHA256`. The GitHub environment `production` exists, with `parsakhaz` as required reviewer and deploys only from `main`. The workflow fails unless `github.actor` and `github.triggering_actor` are both `parsakhaz` |
| Limit who can deploy | In GCP, the Workload Identity provider's attribute condition accepts only `refs/heads/main` for the `production` environment, so a run from another branch gets no credentials (Parsa sets this) |
| Create the VMs, addresses, firewall and uptime checks | The deploy service account needs `roles/compute.admin`, `roles/secretmanager.admin`, `roles/monitoring.editor`, `roles/serviceusage.serviceUsageAdmin`, and `roles/iam.serviceAccountUser` on `pane-push-sender` |
| Four e2-small VMs and four static IPv4 addresses | Billing on `pane-pwa-preview`, about $60 to $75 a month |
| Store the APNs key in Secret Manager (once) | The Pane app's `.p8` key, and `gcloud` signed in as an account with Secret Manager admin on the project |
| Android app links (`assetlinks.json`) | The SHA-256 of the Play app signing certificate (Play Console › App integrity) |
| iOS universal links | Team id and bundle id `com.dcouple.pane.mobile` |
| Android alerts | `pane-push-sender` with Firebase Cloud Messaging send rights, and `roles/artifactregistry.reader` on the `pane-preview` repository so the VMs can pull the relay image |
| Google Trust Services EAB keys | `publicca.googleapis.com` enabled (`deploy.sh` enables it) and `pane-push-sender` granted `roles/publicca.externalAccountKeyCreator` on the project (once, by hand: done 2026-11-20). The VMs already have the `cloud-platform` scope |

## Steps

1. **Buy the domain** and keep the registrar page open for step 5.
2. **Add the repository variables** above (GitHub › Settings › Secrets and
   variables › Actions › Variables). None of them is a secret.
3. **Store the APNs key once**, from a Mac that has it:

   ```sh
   gcloud auth login <account>
   gcloud --account=<account> --project=pane-pwa-preview \
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
   sign-ups outpace it. A computer that Let's Encrypt turns away orders from
   Google Trust Services instead (100 orders an hour for the project, renewals
   included). Only when both refuse does **Add a device** say so and ask again:
   at the time Let's Encrypt gives when Google Trust Services can't be used,
   otherwise within 30 minutes.
8. **Release the desktop app** through the normal [stable release](../../RUNBOOK.md#stable-release),
   then pair a phone with a QR code against production
   ([QR pairing](../../docs/QR_PAIRING.md)).

## Update or roll back

Rerun the workflow with `apply` on from the commit to deploy: it pushes
`pane-relay:<commit>` and restarts each VM on it. Computers reconnect on their
own within 30 seconds. To roll back, run it from the earlier commit.

- **Deploy the relays before releasing a desktop build that needs a new relay
  feature.** A desktop with the Google Trust Services fallback asks its relay
  for EAB keys; an older relay never answers, so the fallback is skipped.
- A rollback to a commit before the Google Trust Services fallback drops
  `pki.goog` from CAA, and computers holding a Google Trust Services
  certificate then renew at Let's Encrypt. Keep `--caa-issuer
  letsencrypt.org,pki.goog` on such a rollback when Let's Encrypt is still
  refusing new computers.

## Watch

- Uptime checks `pane-relay-us`, `-eu`, `-asia`, `-west` in Cloud Monitoring.
- Logs: `gcloud compute ssh pane-relay-us --zone us-central1-a -- docker logs pane-relay`.
  They show ids, IP addresses, byte counts and close reasons, never payloads.
- Block a computer: add its id to the blocklist file and pass `--blocklist`
  (see [relay/README.md](../README.md)).
- Google Trust Services keys: the logs show each key minted (`EAB key minted`,
  with the computer id and the key id, never the key itself) or failed, and
  `EAB keys throttled relay-wide` when a relay reaches its hourly cap.
