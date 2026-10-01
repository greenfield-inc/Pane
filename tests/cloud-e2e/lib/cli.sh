# shellcheck shell=bash
# Resolve the runpane CLI under test and give it an isolated cloud config.
#   E2E_RUNPANE_BIN      path to a runpane executable or cli.js (highest priority)
#   E2E_RUNPANE_TGZ_URL  runpane tarball URL (fork pre-release); installed once into a cache
#   (default)            the tarball named in ~/rc-loop/results/dist-current.md, else `runpane` on PATH
# Exposes: rpc <args...>  (runpane with RUNPANE_CLOUD_DIR / RUNPANE_CLOUD_DESKTOP_DIR isolated to the run)

E2E_DIST_CURRENT="${E2E_DIST_CURRENT:-$HOME/rc-loop/results/dist-current.md}"

dist_url() {  # dist_url <deb|tgz>
  [ -f "$E2E_DIST_CURRENT" ] || return 1
  case "$1" in
    deb) grep -oE 'https://[^ )]+_amd64\.deb' "$E2E_DIST_CURRENT" | head -1 ;;
    tgz) grep -oE 'https://[^ )]+runpane-[^ )]+\.tgz' "$E2E_DIST_CURRENT" | head -1 ;;
    golden) sed -n '/golden:start/,/golden:end/p' "$E2E_DIST_CURRENT" | grep -oE 'rp-loop-golden-[A-Za-z0-9._-]+' | head -1 ;;
  esac
}

cli_resolve() {
  if [ -n "${E2E_RUNPANE_BIN:-}" ]; then
    RUNPANE_CMD=("$E2E_RUNPANE_BIN"); [[ "$E2E_RUNPANE_BIN" == *.js ]] && RUNPANE_CMD=(node "$E2E_RUNPANE_BIN")
  else
    local url="${E2E_RUNPANE_TGZ_URL:-$(dist_url tgz)}"
    if [ -n "$url" ]; then
      local cache; cache="$HOME/.cache/rc-loop-e2e/cli/$(printf '%s' "$url" | sha256sum | cut -c1-16)"
      if [ ! -x "$cache/node_modules/.bin/runpane" ]; then
        mkdir -p "$cache" && (cd "$cache" && npm init -y >/dev/null && npm i --no-audit --no-fund "$url" >npm.log 2>&1) \
          || { log "could not install runpane from $url"; return 1; }
      fi
      RUNPANE_CMD=("$cache/node_modules/.bin/runpane"); E2E_CLI_SOURCE="$url"
    else
      RUNPANE_CMD=(runpane); E2E_CLI_SOURCE="PATH:$(command -v runpane)"
    fi
  fi
  E2E_CLI_SOURCE="${E2E_CLI_SOURCE:-$E2E_RUNPANE_BIN}"
  export RUNPANE_CLOUD_DIR="${RUNPANE_CLOUD_DIR_OVERRIDE:-$E2E_SECRETS/cloud}"
  export RUNPANE_CLOUD_DESKTOP_DIR="${RUNPANE_CLOUD_DESKTOP_DIR_OVERRIDE:-$E2E_SECRETS/desktop}"
  (umask 077; mkdir -p "$RUNPANE_CLOUD_DIR" "$RUNPANE_CLOUD_DESKTOP_DIR")
  log "runpane under test: ${RUNPANE_CMD[*]} ($E2E_CLI_SOURCE) version=$("${RUNPANE_CMD[@]}" version 2>/dev/null | head -1)"
}

rpc() { env -u PANE_SESSION_ID -u PANE_PANEL_ID -u PANE_ORCHESTRATION_SESSION_ID "${RUNPANE_CMD[@]}" "$@"; }

# cloud_setup_from_loop_secrets [extra setup flags...] : non-interactive `runpane cloud setup` from the loop's 0600 files
cloud_setup_from_loop_secrets() {
  local keyf="$E2E_SECRETS/boat.key"
  if [ ! -s "$keyf" ]; then
    (umask 077; sed -E 's/^[^:]*:[[:space:]]*(Bearer[[:space:]]+)?//' "${CLOUDLAB_BOAT_AUTH_HEADER_FILE:-$HOME/rc-loop/secrets/boat.hdr}" | tr -d '\r\n' > "$keyf")
  fi
  rpc cloud setup --boat-key-file "$keyf" \
    --tailscale-client-id "${CLOUDLAB_TS_CLIENT_ID:-krreHuCr3M11CNTRL}" \
    --tailscale-secret-file "${CLOUDLAB_TS_SECRET_FILE:-$HOME/rc-loop/secrets/TAILSCALE_OAUTH_SECRET}" \
    --name-prefix "$E2E_PREFIX" "$@" --json
}

# host_record <hostname> -> path of the CLI's saved host record
host_record() { echo "$RUNPANE_CLOUD_DIR/hosts/$1.json"; }
