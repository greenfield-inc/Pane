#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-pane-pwa-preview}"
PROJECT_NAME="${PROJECT_NAME:-Pane PWA Preview}"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-019B6D-4631BC-4B75C5}"
ORG_DOMAIN="${ORG_DOMAIN:-dcouple.ai}"
REGION="${REGION:-us-central1}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-pane-preview}"
CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-pane-remote-pwa-preview}"
RUNTIME_SERVICE_ACCOUNT_ID="${RUNTIME_SERVICE_ACCOUNT_ID:-pane-remote-pwa-runtime}"
DEPLOY_SERVICE_ACCOUNT_ID="${DEPLOY_SERVICE_ACCOUNT_ID:-pane-remote-pwa-deploy}"
WORKLOAD_IDENTITY_POOL_ID="${WORKLOAD_IDENTITY_POOL_ID:-github}"
WORKLOAD_IDENTITY_PROVIDER_ID="${WORKLOAD_IDENTITY_PROVIDER_ID:-pane-nightly}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-greenfield-inc/Pane}"
GITHUB_REF="${GITHUB_REF:-refs/heads/nightly}"

APIS=(
  artifactregistry.googleapis.com
  cloudresourcemanager.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  run.googleapis.com
  serviceusage.googleapis.com
)

PROJECT_LABELS="app=pane,environment=staging,surface=pwa-preview"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SERVICE_ACCOUNT="${DEPLOY_SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

run_gcloud() {
  gcloud "$@" --project="$PROJECT_ID"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command gcloud

if ! run_gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  ORG_ID="${ORG_ID:-$(run_gcloud organizations list --filter="displayName=${ORG_DOMAIN}" --format='value(ID)' --limit=1)}"
  if [[ -z "$ORG_ID" ]]; then
    echo "Could not resolve GCP organization for ${ORG_DOMAIN}. Set ORG_ID and retry." >&2
    exit 1
  fi

  run_gcloud projects create "$PROJECT_ID" \
    --name="$PROJECT_NAME" \
    --organization="$ORG_ID" \
    --labels="$PROJECT_LABELS"
fi

run_gcloud billing projects link "$PROJECT_ID" \
  --billing-account="$BILLING_ACCOUNT_ID"

run_gcloud services enable "${APIS[@]}"

run_gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
  --location="$REGION" >/dev/null 2>&1 || \
  run_gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Pane remote PWA preview containers"

for service_account_id in "$RUNTIME_SERVICE_ACCOUNT_ID" "$DEPLOY_SERVICE_ACCOUNT_ID"; do
  if ! run_gcloud iam service-accounts describe "${service_account_id}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    run_gcloud iam service-accounts create "$service_account_id" \
      --display-name="$service_account_id"
  fi
done

PROJECT_NUMBER="$(run_gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

run_gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT}" \
  --role=roles/run.admin \
  --condition=None >/dev/null

run_gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT}" \
  --role=roles/artifactregistry.writer \
  --condition=None >/dev/null

run_gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SERVICE_ACCOUNT" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT}" \
  --role=roles/iam.serviceAccountUser \
  --condition=None >/dev/null

if ! run_gcloud iam workload-identity-pools describe "$WORKLOAD_IDENTITY_POOL_ID" \
  --location=global >/dev/null 2>&1; then
  run_gcloud iam workload-identity-pools create "$WORKLOAD_IDENTITY_POOL_ID" \
    --location=global \
    --display-name="GitHub Actions"
fi

if ! run_gcloud iam workload-identity-pools providers describe "$WORKLOAD_IDENTITY_PROVIDER_ID" \
  --location=global \
  --workload-identity-pool="$WORKLOAD_IDENTITY_POOL_ID" >/dev/null 2>&1; then
  run_gcloud iam workload-identity-pools providers create-oidc "$WORKLOAD_IDENTITY_PROVIDER_ID" \
    --location=global \
    --workload-identity-pool="$WORKLOAD_IDENTITY_POOL_ID" \
    --display-name="Pane nightly deploys" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.ref == '${GITHUB_REF}'"
fi

run_gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SERVICE_ACCOUNT" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_IDENTITY_POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}" \
  --role=roles/iam.workloadIdentityUser \
  --condition=None >/dev/null

WORKLOAD_IDENTITY_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_IDENTITY_POOL_ID}/providers/${WORKLOAD_IDENTITY_PROVIDER_ID}"

cat <<EOF
GCP setup complete.

GitHub repository variables:
  GCP_PROJECT_ID=${PROJECT_ID}
  GCP_REGION=${REGION}
  GAR_REPOSITORY=${ARTIFACT_REPOSITORY}
  CLOUD_RUN_SERVICE=${CLOUD_RUN_SERVICE}
  GCP_WORKLOAD_IDENTITY_PROVIDER=${WORKLOAD_IDENTITY_PROVIDER}
  GCP_DEPLOY_SERVICE_ACCOUNT=${DEPLOY_SERVICE_ACCOUNT}
  CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SERVICE_ACCOUNT}

To set them with GitHub CLI:
  gh variable set GCP_PROJECT_ID --repo ${GITHUB_REPOSITORY} --body "${PROJECT_ID}"
  gh variable set GCP_REGION --repo ${GITHUB_REPOSITORY} --body "${REGION}"
  gh variable set GAR_REPOSITORY --repo ${GITHUB_REPOSITORY} --body "${ARTIFACT_REPOSITORY}"
  gh variable set CLOUD_RUN_SERVICE --repo ${GITHUB_REPOSITORY} --body "${CLOUD_RUN_SERVICE}"
  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo ${GITHUB_REPOSITORY} --body "${WORKLOAD_IDENTITY_PROVIDER}"
  gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo ${GITHUB_REPOSITORY} --body "${DEPLOY_SERVICE_ACCOUNT}"
  gh variable set CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT --repo ${GITHUB_REPOSITORY} --body "${RUNTIME_SERVICE_ACCOUNT}"

After the first successful workflow run, verify the Cloud Run URL and then map app-preview.runpane.com.
EOF
