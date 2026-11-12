#!/usr/bin/env bash

# Publish an existing draft release without overwriting a manually authored body.
# Every published body ends with a Download section: one link per installer on
# this tag, through runpane.com/api/download with source=gh-release, so GitHub
# downloads are counted like the website's. The link lands on the same file.
set -euo pipefail

repo="${1:?usage: publish-github-release.sh OWNER/REPO TAG}"
tag="${2:?usage: publish-github-release.sh OWNER/REPO TAG}"

# The REST tag endpoint only finds published releases. `release view` also
# resolves drafts, including the draft populated by the platform build jobs.
release="$(gh release view "${tag}" --repo "${repo}" \
  --json databaseId,isDraft,body,assets --jq '{id: .databaseId, draft: .isDraft, body, assets: [.assets[].name]}')"
release_id="$(jq -er '.id' <<<"${release}")"
release_is_draft="$(jq -r '.draft == true' <<<"${release}")"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
update_file="${work_dir}/release-update.json"

# Installers only, in reading order. The names match runpane.com's
# /api/download allowlist; updater zips, blockmaps and metadata are skipped.
download_section() {
  jq -r --arg tag "${tag}" '
    def asset_label: {
      "macOS-arm64.dmg": "macOS (Apple Silicon)", "macOS-x64.dmg": "macOS (Intel)", "macOS-universal.dmg": "macOS (Universal)",
      "Windows-x64.exe": "Windows (x64)", "Windows-arm64.exe": "Windows (ARM64)",
      "linux-x86_64.AppImage": "Linux x64 (AppImage)", "linux-amd64.deb": "Linux x64 (.deb)",
      "linux-arm64.AppImage": "Linux ARM64 (AppImage)", "linux-arm64.deb": "Linux ARM64 (.deb)"
    }[capture("^Pane-[0-9.]+-(?<k>.+)$").k];
    [.assets[] | select(test("^Pane-[0-9.]+-(macOS-(universal|arm64|x64)\\.dmg|Windows-(x64|arm64)\\.exe|linux-(amd64|arm64)\\.deb|linux-(arm64|x86_64)\\.AppImage)$"))]
    | sort_by(asset_label as $l | ["macOS (Apple Silicon)", "macOS (Intel)", "macOS (Universal)", "Windows (x64)", "Windows (ARM64)", "Linux x64 (AppImage)", "Linux x64 (.deb)", "Linux ARM64 (AppImage)", "Linux ARM64 (.deb)"] | index($l))
    | if length == 0 then empty else
        "<!-- pane-download-links -->\n## Download\n\n"
        + (map("- \(asset_label): [\(.)](https://runpane.com/api/download?file=\(. | @uri)&v=\($tag | @uri)&source=gh-release)") | join("\n"))
        + "\n\nOr install from a terminal: `curl -fsSL https://runpane.com/install.sh | sh` (macOS, Linux) or `irm https://runpane.com/install.ps1 | iex` (Windows)."
      end
  ' <<<"${release}"
}

with_downloads() {
  local body="$1" section
  # A broken section must not hold up the release: publish without it.
  if ! section="$(download_section)"; then
    echo "warning: could not build the Download section for ${tag}; publishing without it" >&2
    section=""
  fi
  if [[ -z "${section}" ]] || grep -Fq '<!-- pane-download-links -->' <<<"${body}"; then
    printf '%s' "${body}"
  else
    printf '%s\n\n%s' "${body%$'\n'}" "${section}"
  fi
}

if [[ "${release_is_draft}" == "true" ]] && jq -e '(.body // "") | type == "string" and test("^[[:space:]]*$")' <<<"${release}" >/dev/null; then
  notes_file="${work_dir}/generated-notes.json"
  gh api "repos/${repo}/releases/generate-notes" -X POST -f "tag_name=${tag}" >"${notes_file}"
  jq -e '(.body | type == "string") and (.body | test("\\S"))' "${notes_file}" >/dev/null
  body="$(with_downloads "$(jq -r '.body' "${notes_file}")")"
  jq -n --arg body "${body}" '{ body: $body, draft: false, make_latest: true }' >"${update_file}"
elif [[ "${release_is_draft}" == "true" ]]; then
  # A manually authored draft keeps its text; only the Download section is added.
  body="$(with_downloads "$(jq -r '.body' <<<"${release}")")"
  jq -n --arg body "${body}" '{ body: $body, draft: false, make_latest: true }' >"${update_file}"
else
  jq -n '{ draft: false, make_latest: true }' >"${update_file}"
fi

gh api "repos/${repo}/releases/${release_id}" -X PATCH --input "${update_file}"
