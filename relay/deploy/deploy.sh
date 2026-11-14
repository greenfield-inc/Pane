#!/usr/bin/env bash
# Creates or updates Pane's three relays on Google Compute Engine.
# Prints every command and changes nothing unless --apply is given.
# See relay/deploy/RUNBOOK.md for what each step needs.
#
#   relay/deploy/deploy.sh --image <registry/pane-relay:tag> [--apply]
#
# Environment (defaults in brackets):
#   GCP_PROJECT_ID [pane-pwa-preview]  PANE_RELAY_DOMAIN [runpane.net]
#   PANE_RELAY_MACHINE_TYPE [e2-small]  PANE_RELAY_ACME_EMAIL (required)
#   PANE_RELAY_SERVICE_ACCOUNT [pane-push-sender@<project>.iam.gserviceaccount.com]
#   PANE_RELAY_ANDROID_CERT_SHA256 (comma list, for assetlinks.json)
#   PANE_RELAY_APNS_KEY_FILE, PANE_RELAY_APNS_KEY_ID, PANE_RELAY_APNS_TEAM_ID
#     (the Pane app's APNs .p8; stored once in Secret Manager)
set -euo pipefail

APPLY=0
IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --image) IMAGE="$2"; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$IMAGE" ] || { echo "--image is required" >&2; exit 2; }

PROJECT="${GCP_PROJECT_ID:-pane-pwa-preview}"
DOMAIN="${PANE_RELAY_DOMAIN:-runpane.net}"
MACHINE="${PANE_RELAY_MACHINE_TYPE:-e2-small}"
SA="${PANE_RELAY_SERVICE_ACCOUNT:-pane-push-sender@${PROJECT}.iam.gserviceaccount.com}"
ACME_EMAIL="${PANE_RELAY_ACME_EMAIL:?PANE_RELAY_ACME_EMAIL is required}"
ANDROID_SHA="${PANE_RELAY_ANDROID_CERT_SHA256:-}"
APNS_KEY_ID="${PANE_RELAY_APNS_KEY_ID:-}"
APNS_TEAM_ID="${PANE_RELAY_APNS_TEAM_ID:-}"

# region name, GCE region, zone, runs the DNS helper (ns name or empty)
RELAYS=(
  "us us-central1 us-central1-a ns1"
  "eu europe-west1 europe-west1-b ns2"
  "asia asia-southeast1 asia-southeast1-a "
)

run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [ "$APPLY" = 1 ]; then "$@"; fi
}

gc() { run gcloud --project "$PROJECT" "$@"; }

exists() { gcloud --project "$PROJECT" "$@" >/dev/null 2>&1; }

# 0. APIs, and the two secrets the VMs read with their own identity.
gc services enable compute.googleapis.com secretmanager.googleapis.com monitoring.googleapis.com
if ! exists secrets describe pane-relay-registry-secret; then
  if [ "$APPLY" = 1 ]; then
    openssl rand -base64 32 | gcloud --project "$PROJECT" secrets create pane-relay-registry-secret --data-file=-
  else
    echo "+ openssl rand -base64 32 | gcloud secrets create pane-relay-registry-secret --data-file=-"
  fi
fi
if [ -n "${PANE_RELAY_APNS_KEY_FILE:-}" ] && ! exists secrets describe pane-relay-apns-key; then
  gc secrets create pane-relay-apns-key --data-file="$PANE_RELAY_APNS_KEY_FILE"
fi
for secret in pane-relay-registry-secret pane-relay-apns-key; do
  if [ "$secret" = pane-relay-apns-key ] && [ -z "${PANE_RELAY_APNS_KEY_FILE:-}" ] && ! exists secrets describe "$secret"; then continue; fi
  gc secrets add-iam-policy-binding "$secret" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done

# 1. Firewall: https, DNS, QUIC address discovery.
if ! exists compute firewall-rules describe pane-relay; then
  gc compute firewall-rules create pane-relay --network default --direction INGRESS \
    --target-tags pane-relay --source-ranges 0.0.0.0/0 \
    --allow tcp:443,udp:53,tcp:53,udp:7842
fi

# 2. One static IPv4 per region. Without --apply the addresses are unknown, so
#    the flags below show placeholders.
for line in "${RELAYS[@]}"; do
  read -r name region _zone _ns <<<"$line"
  if ! exists compute addresses describe "pane-relay-$name" --region "$region"; then
    gc compute addresses create "pane-relay-$name" --region "$region"
  fi
  ip=$(gcloud --project "$PROJECT" compute addresses describe "pane-relay-$name" --region "$region" --format='value(address)' 2>/dev/null || true)
  printf -v "IP_$name" '%s' "${ip:-<$name-ip>}"
done

# shellcheck disable=SC2154 # IP_<region> is set with printf -v above.
REGION_IPS="us=${IP_us},eu=${IP_eu},asia=${IP_asia}"
RELAY_HOSTS="us=us.relay.$DOMAIN,eu=eu.relay.$DOMAIN,asia=asia.relay.$DOMAIN"
NS_IPS="ns1=${IP_us},ns2=${IP_eu}"

# 3. The VMs. The startup script reads secrets from Secret Manager with the VM's
#    own identity and (re)starts the container; rerunning it updates the image.
for line in "${RELAYS[@]}"; do
  read -r name region zone ns <<<"$line"
  # A helper updates itself in memory, so it lists only the other helper.
  dns_flag=""
  case "$name" in
    us) helpers="https://eu.relay.$DOMAIN/v1/registry" ;;
    eu) helpers="https://us.relay.$DOMAIN/v1/registry" ;;
    *) helpers="https://us.relay.$DOMAIN/v1/registry,https://eu.relay.$DOMAIN/v1/registry" ;;
  esac
  if [ -n "$ns" ]; then dns_flag="--dns 0.0.0.0:53"; fi
  startup=$(cat <<EOF
#!/bin/bash
set -euo pipefail
token=\$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
secret() { curl -sf -H "Authorization: Bearer \$token" "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/\$1/versions/latest:access" | sed -E 's/.*"data":"([^"]+)".*/\1/' | base64 -d; }
install -d -m 0700 -o 65532 -g 65532 /var/lib/pane-relay
secret pane-relay-registry-secret > /var/lib/pane-relay/registry-secret
secret pane-relay-apns-key > /var/lib/pane-relay/apns-key.p8 || rm -f /var/lib/pane-relay/apns-key.p8
chown 65532:65532 /var/lib/pane-relay/* && chmod 0600 /var/lib/pane-relay/*
docker-credential-gcr configure-docker --registries=\$(echo "$IMAGE" | cut -d/ -f1) >/dev/null 2>&1 || true
docker pull "$IMAGE"
docker rm -f pane-relay >/dev/null 2>&1 || true
apns=""
if [ -s /var/lib/pane-relay/apns-key.p8 ] && [ -n "$APNS_KEY_ID" ]; then
  apns="--apns-key-path /data/apns-key.p8 --apns-key-id $APNS_KEY_ID --apns-team-id $APNS_TEAM_ID"
fi
docker run -d --name pane-relay --restart always \
  -p 443:443/tcp -p 53:53/udp -p 53:53/tcp -p 7842:7842/udp \
  -v /var/lib/pane-relay:/data \
  -e PANE_RELAY_REGISTRY_SECRET="\$(cat /var/lib/pane-relay/registry-secret)" \
  "$IMAGE" \
  --domain $DOMAIN --region $name --listen 0.0.0.0:443 \
  --relays $RELAY_HOSTS --region-ip $REGION_IPS --public-ip ${IP_us} \
  --ns-ip $NS_IPS --registry-url $helpers $dns_flag \
  --direct-quic 0.0.0.0:7842 \
  --acme-email $ACME_EMAIL --acme-cache /data/acme \
  --fcm-project $PROJECT \${apns} ${ANDROID_SHA:+--android-cert-sha256 $ANDROID_SHA}
EOF
)
  if exists compute instances describe "pane-relay-$name" --zone "$zone"; then
    gc compute instances add-metadata "pane-relay-$name" --zone "$zone" --metadata "startup-script=$startup"
    gc compute instances reset "pane-relay-$name" --zone "$zone"
  else
    # Secret Manager accepts only the cloud-platform scope, so the scope stays
    # broad; the service account's IAM roles (FCM send, secret access) are the limit.
    gc compute instances create "pane-relay-$name" --zone "$zone" --machine-type "$MACHINE" \
      --image-family cos-stable --image-project cos-cloud --tags pane-relay \
      --address "pane-relay-$name" --service-account "$SA" --scopes cloud-platform \
      --metadata "startup-script=$startup"
  fi
done

# 4. Uptime checks on each relay's /healthz.
for line in "${RELAYS[@]}"; do
  read -r name _ _ _ <<<"$line"
  if [ -z "$(gcloud --project "$PROJECT" monitoring uptime list-configs --filter="displayName=pane-relay-$name" --format='value(name)' 2>/dev/null)" ]; then
    gc monitoring uptime create "pane-relay-$name" --resource-type uptime-url \
      --resource-labels "host=$name.relay.$DOMAIN,project_id=$PROJECT" --path /healthz --protocol https
  fi
done

echo
echo "Registrar for $DOMAIN: name servers ns1.$DOMAIN (${IP_us}) and ns2.$DOMAIN (${IP_eu}), with glue records."
