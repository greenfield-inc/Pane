#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="${root_dir}/scripts/publish-github-release.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

mkdir -p "${temp_dir}/bin"
cat >"${temp_dir}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${GH_LOG}"
if [[ "$1" == "release" && "$2" == "view" && "$3" == "v9.9.9" ]]; then
  if [[ "${GH_LOOKUP_FAIL:-false}" == "true" ]]; then
    echo 'release not found' >&2
    exit 1
  fi
  printf '%s\n' "${GH_RELEASE_JSON}"
  exit 0
fi
endpoint="${2:?missing endpoint}"

case "${endpoint}" in
  repos/greenfield-inc/Pane/releases/tags/v9.9.9)
    echo 'Not Found (HTTP 404): drafts are not available by tag' >&2
    exit 1
    ;;
  repos/greenfield-inc/Pane/releases/generate-notes)
    printf '%s\n' "${GH_GENERATED_NOTES_JSON}"
    ;;
  repos/greenfield-inc/Pane/releases/42)
    while (($#)); do
      if [[ "$1" == "--input" ]]; then
        cp "$2" "${GH_UPDATE_JSON}"
        exit 0
      fi
      shift
    done
    echo 'missing --input' >&2
    exit 1
    ;;
  *)
    echo "unexpected endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${temp_dir}/bin/gh"

run_case() {
  local name="$1"
  local release_json="$2"
  local generated_notes_json="$3"
  local case_dir="${temp_dir}/${name}"
  mkdir -p "${case_dir}"
  PATH="${temp_dir}/bin:${PATH}" \
    GH_LOG="${case_dir}/gh.log" \
    GH_RELEASE_JSON="${release_json}" \
    GH_GENERATED_NOTES_JSON="${generated_notes_json}" \
    GH_UPDATE_JSON="${case_dir}/update.json" \
    bash "${script}" greenfield-inc/Pane v9.9.9 >/dev/null
}

assets='["Pane-9.9.9-linux-arm64.deb","Pane-9.9.9-Windows-x64.exe","Pane-9.9.9-macOS-arm64.dmg","Pane-9.9.9-macOS-arm64.zip","Pane-9.9.9-Windows-x64.exe.blockmap","latest-mac.yml","Pane-9.9.9-linux-x86_64.AppImage","Pane-9.9.9-macOS-x64.dmg","Pane-9.9.9-Windows-arm64.exe","Pane-9.9.9-linux-amd64.deb","Pane-9.9.9-linux-arm64.AppImage","SHA256SUMS.txt"]'
downloads='<!-- pane-download-links -->
## Download

- macOS (Apple Silicon): [Pane-9.9.9-macOS-arm64.dmg](https://runpane.com/api/download?file=Pane-9.9.9-macOS-arm64.dmg&v=v9.9.9&source=gh-release)
- macOS (Intel): [Pane-9.9.9-macOS-x64.dmg](https://runpane.com/api/download?file=Pane-9.9.9-macOS-x64.dmg&v=v9.9.9&source=gh-release)
- Windows (x64): [Pane-9.9.9-Windows-x64.exe](https://runpane.com/api/download?file=Pane-9.9.9-Windows-x64.exe&v=v9.9.9&source=gh-release)
- Windows (ARM64): [Pane-9.9.9-Windows-arm64.exe](https://runpane.com/api/download?file=Pane-9.9.9-Windows-arm64.exe&v=v9.9.9&source=gh-release)
- Linux x64 (AppImage): [Pane-9.9.9-linux-x86_64.AppImage](https://runpane.com/api/download?file=Pane-9.9.9-linux-x86_64.AppImage&v=v9.9.9&source=gh-release)
- Linux x64 (.deb): [Pane-9.9.9-linux-amd64.deb](https://runpane.com/api/download?file=Pane-9.9.9-linux-amd64.deb&v=v9.9.9&source=gh-release)
- Linux ARM64 (AppImage): [Pane-9.9.9-linux-arm64.AppImage](https://runpane.com/api/download?file=Pane-9.9.9-linux-arm64.AppImage&v=v9.9.9&source=gh-release)
- Linux ARM64 (.deb): [Pane-9.9.9-linux-arm64.deb](https://runpane.com/api/download?file=Pane-9.9.9-linux-arm64.deb&v=v9.9.9&source=gh-release)

Or install from a terminal: `curl -fsSL https://runpane.com/install.sh | sh` (macOS, Linux) or `irm https://runpane.com/install.ps1 | iex` (Windows).'

expect_body() {
  local file="$1" expected="$2"
  if ! jq -e --arg body "${expected}" '.body == $body and .draft == false and .make_latest == true' "${file}" >/dev/null; then
    echo "unexpected release update in ${file}:" >&2
    jq -r '.body' "${file}" >&2
    exit 1
  fi
}

run_case \
  empty-draft \
  "{\"id\":42,\"draft\":true,\"body\":\"\",\"assets\":${assets}}" \
  '{"name":"v9.9.9","body":"## What changed\n\n- Added safe release notes"}'

grep -F 'repos/greenfield-inc/Pane/releases/generate-notes -X POST -f tag_name=v9.9.9' "${temp_dir}/empty-draft/gh.log" >/dev/null
expect_body "${temp_dir}/empty-draft/update.json" "## What changed

- Added safe release notes

${downloads}"

# Every link names a file on this tag, so it resolves to that exact asset.
jq -r '.body' "${temp_dir}/empty-draft/update.json" | grep -o 'file=[^&]*&v=[^&]*' | while IFS= read -r link; do
  file="${link#file=}"; file="${file%%&*}"
  jq -e --arg f "${file}" 'index($f) != null' <<<"${assets}" >/dev/null || { echo "link to missing asset ${file}" >&2; exit 1; }
  [[ "${link}" == *"&v=v9.9.9" ]] || { echo "link not pinned to v9.9.9: ${link}" >&2; exit 1; }
done

run_case \
  no-installers \
  '{"id":42,"draft":true,"body":"","assets":["latest.yml"]}' \
  '{"name":"v9.9.9","body":"Notes only"}'
expect_body "${temp_dir}/no-installers/update.json" "Notes only"

run_case \
  already-linked \
  "{\"id\":42,\"draft\":true,\"body\":\"Intro\\n\\n<!-- pane-download-links -->\\n## Download\\n\\n- kept\",\"assets\":${assets}}" \
  '{"name":"v9.9.9","body":"must not be used"}'
expect_body "${temp_dir}/already-linked/update.json" "Intro

<!-- pane-download-links -->
## Download

- kept"

run_case \
  manual-body \
  "{\"id\":42,\"draft\":true,\"body\":\"## Installer notes\\n\\nKeep this text.\",\"assets\":${assets}}" \
  '{"name":"v9.9.9","body":"must not be used"}'

if grep -Fq 'releases/generate-notes' "${temp_dir}/manual-body/gh.log"; then
  echo 'manual release body was unexpectedly replaced' >&2
  exit 1
fi
expect_body "${temp_dir}/manual-body/update.json" "## Installer notes

Keep this text.

${downloads}"

run_case \
  published-empty \
  "{\"id\":42,\"draft\":false,\"body\":\"\",\"assets\":${assets}}" \
  '{"name":"v9.9.9","body":"must not be used"}'

if grep -Fq 'releases/generate-notes' "${temp_dir}/published-empty/gh.log"; then
  echo 'a published release was unexpectedly regenerated' >&2
  exit 1
fi
jq -e '((has("body") | not) and .draft == false and .make_latest == true)' "${temp_dir}/published-empty/update.json" >/dev/null

if GH_LOOKUP_FAIL=true run_case missing-release '{}' '{}'; then
  echo 'missing release was unexpectedly published' >&2
  exit 1
fi
if [[ -e "${temp_dir}/missing-release/update.json" ]]; then
  echo 'failed lookup must not mutate a release' >&2
  exit 1
fi

echo 'publish GitHub release tests passed'
