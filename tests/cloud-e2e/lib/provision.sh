# shellcheck shell=bash
# Manual cloud-Session fixture: what `runpane cloud new` is supposed to do, done by the harness
# through the provider + Tailscale APIs. Used by the M0 harness proof, and by M2/M3 gates when a
# run is pinned to a daemon build without going through the CLI (E2E_PROVISION=manual).
#
# Inputs (env, all optional):
#   E2E_DAEMON_DEB_URL   fork Pane .deb to install (else `npx runpane@latest install daemon --format deb`)
#   E2E_RUNPANE_TGZ_URL  fork runpane CLI tarball to use inside the sandbox (else the daemon's own shim / runpane@latest)
#   E2E_FROM_SNAPSHOT    named snapshot (golden) to fork from
# Outputs (globals): SB_ID SB_NAME SB_HOST SB_NODE SB_PAIRING (local 0600 file) SB_BASE

# rp_shim: in-sandbox `rp` = the runpane CLI talking to ~/.pane_remote over the local socket.
_rp_shim_script() {
  cat <<'SH'
mkdir -p /home/user/rcl
cat > /home/user/rcl/rp <<'RP'
#!/bin/bash
export PANE_DIR="$HOME/.pane_remote"
unset PANE_SESSION_ID PANE_PANEL_ID PANE_ORCHESTRATION_SESSION_ID
if [ -x "$HOME/rcl/runpane/node_modules/.bin/runpane" ]; then exec "$HOME/rcl/runpane/node_modules/.bin/runpane" "$@"; fi
if [ -x "$PANE_DIR/bin/runpane" ]; then exec "$PANE_DIR/bin/runpane" "$@"; fi
exec npx --yes runpane@latest "$@"
RP
chmod 755 /home/user/rcl/rp
SH
}

provision_manual() {
  local role="$1" size="${2:-default}" t0
  local suffix="$role-$(date -u +%H%M%S)"
  SB_NAME="$E2E_PREFIX-$suffix"
  SB_HOST="$SB_NAME"
  t0=$(ms_now)
  SB_ID=$(sb_create "$suffix" "$size" "${E2E_FROM_SNAPSHOT:-}") || { rec "provision.$role" FAIL "sandbox create failed"; return 1; }
  local waited
  waited=$(cl boat wait "$SB_ID" idle,ready,running --timeout 240) || { rec "provision.$role" FAIL "sandbox never became ready: $waited"; return 1; }
  rec "provision.$role.create" PASS "sandbox $SB_ID ($SB_NAME, $size) ready in $(secs_since "$t0")s" "" "seconds=$(secs_since "$t0")"

  t0=$(ms_now)
  SB_NODE=$(sb_tailnet_join "$SB_ID" "$SB_HOST" | tail -1)
  [ -n "$SB_NODE" ] || { rec "provision.$role.tailnet" FAIL "tailnet join failed"; return 1; }

  t0=$(ms_now)
  local install
  if [ -n "${E2E_DAEMON_DEB_URL:-}" ]; then
    install="curl -fsSL -o /home/user/rcl/pane.deb '$E2E_DAEMON_DEB_URL' && sudo apt-get install -y /home/user/rcl/pane.deb >/home/user/rcl/apt.log 2>&1 && pane --remote-setup --label '$SB_NAME' --prefer-tunnel tailscale"
  else
    install="npx --yes runpane@latest install daemon --label '$SB_NAME' --format deb --prefer-tunnel tailscale"
  fi
  local out
  out=$(sbx "$SB_ID" 600 <<SH
set -e
$(_rp_shim_script)
if [ -n "${E2E_RUNPANE_TGZ_URL:-}" ]; then mkdir -p /home/user/rcl/runpane && cd /home/user/rcl/runpane && npm init -y >/dev/null && npm i --no-audit --no-fund '${E2E_RUNPANE_TGZ_URL:-}' >/home/user/rcl/runpane-install.log 2>&1; cd /home/user; fi
umask 077
cat > /home/user/rcl/install.sh <<'INSTALL'
$install
INSTALL
timeout 240 bash /home/user/rcl/install.sh > /home/user/rcl/install.log 2>&1 || { echo "INSTALL FAILED"; sed -E 's#pane-remote://[A-Za-z0-9_=-]+#pane-remote://<redacted>#g' /home/user/rcl/install.log | tail -40; exit 1; }
grep -oE 'pane-remote://[A-Za-z0-9_=-]+' /home/user/rcl/install.log | tail -1 > /home/user/rcl/pairing.txt
chmod 600 /home/user/rcl/pairing.txt
test -s /home/user/rcl/pairing.txt || { echo "NO PAIRING CODE"; exit 1; }
sed -E 's#pane-remote://[A-Za-z0-9_=-]+#pane-remote://<redacted>#g' /home/user/rcl/install.log | tail -25
echo "pane: \$(pane --version 2>/dev/null | head -1)"
echo "rp: \$(/home/user/rcl/rp version 2>/dev/null | head -1)"
SH
) ; local rc=$?
  printf '%s\n' "$out" | ev "provision-$role-install.txt" >/dev/null
  [ $rc -eq 0 ] || { rec "provision.$role.daemon" FAIL "daemon install failed (see evidence)" "$E2E_RUN_DIR/provision-$role-install.txt"; return 1; }
  SB_PAIRING="$E2E_SECRETS/pairing-$role.txt"
  cl boat fetch "$SB_ID" /home/user/rcl/pairing.txt "$SB_PAIRING" || { rec "provision.$role.daemon" FAIL "could not fetch pairing"; return 1; }
  SB_BASE=$(cl remote base "$SB_PAIRING")
  rec "provision.$role.daemon" PASS "daemon installed in $(secs_since "$t0")s; baseUrl $SB_BASE ($(printf '%s' "$out" | grep -E '^pane:' | head -1))" \
    "$E2E_RUN_DIR/provision-$role-install.txt" "seconds=$(secs_since "$t0")"
  export SB_ID SB_NAME SB_HOST SB_NODE SB_PAIRING SB_BASE
}
