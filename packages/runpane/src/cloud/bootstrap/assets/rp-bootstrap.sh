#!/bin/bash
# rp-bootstrap.sh: sandbox-side provisioning steps for a Runpane Cloud session.
# Uploaded and run by `runpane cloud new` (packages/runpane/src/cloud/bootstrap/provision.ts)
# as the sandbox login user, one step per call:  bash rp-bootstrap.sh <step> [args...]
#
# Every step ends with one line `RP_RESULT <json>` that the caller parses.
# No step ever prints a secret: the Tailscale auth key is read from a 0600 file and shredded,
# and the pane-remote:// pairing code only lands in $RP_STATE/pairing.code (0600).
set -euo pipefail
umask 077

RP_STATE="${RP_STATE:-$HOME/.runpane-cloud}"
RP_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$RP_STATE"
chmod 700 "$RP_STATE"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

result() { printf 'RP_RESULT %s\n' "$1"; }
fail() { result "$(python3 -c 'import json,sys;print(json.dumps({"ok":False,"error":sys.argv[1]}))' "$1")"; exit 1; }

tailscale_backend_state() {
  tailscale status --json 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("BackendState") or "")
except Exception: print("")' || true
}

wait_for_tailscaled() {
  local i state
  for i in $(seq 1 60); do
    state="$(tailscale_backend_state)"
    if [ -n "$state" ]; then echo "$state"; return 0; fi
    sleep 0.5
  done
  return 1
}

# The state tailscaled settles into. Right after a boot or wake it passes NoState and Starting within its
# first second (seen live: NoState -> Starting -> Running in 1 s); deciding on those re-enrolled a healthy
# node. A state still NoState after 30 s is reported as it is (a node that really came back logged out).
wait_for_settled_tailscaled() {
  local i state=""
  for i in $(seq 1 60); do
    state="$(tailscale_backend_state)"
    case "$state" in
      ""|NoState|Starting) sleep 0.5 ;;
      *) echo "$state"; return 0 ;;
    esac
  done
  [ -n "$state" ] && { echo "$state"; return 0; }
  return 1
}

# Tailnet identity as JSON (no secrets): node id, MagicDNS name, IPs, tags, RunSSH.
tailnet_identity_json() {
  local status prefs
  status="$(tailscale status --json)"
  prefs="$(sudo tailscale debug prefs 2>/dev/null || echo '{}')"
  python3 - "$status" "$prefs" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
try:
    prefs = json.loads(sys.argv[2])
except Exception:
    prefs = {}
me = status.get("Self") or {}
print(json.dumps({
    "ok": True,
    "backendState": status.get("BackendState"),
    "nodeId": me.get("ID"),
    "hostname": me.get("HostName"),
    "magicDnsName": (me.get("DNSName") or "").rstrip("."),
    "tailscaleIps": me.get("TailscaleIPs") or [],
    "tags": me.get("Tags") or [],
    "runSsh": bool(prefs.get("RunSSH", False)),
}))
PY
}

pane_listen_port() {
  python3 - "$HOME/.pane_remote/config.json" <<'PY' 2>/dev/null || echo 42137
import json, sys
d = json.load(open(sys.argv[1]))
config = ((d.get("remoteDaemon") or {}).get("host") or {}).get("config") or {}
print(config.get("listenPort") or 42137)
PY
}

pane_version() {
  local pkg
  pkg="$(dpkg -S /opt/Pane 2>/dev/null | head -1 | cut -d: -f1 || true)"
  if [ -n "$pkg" ]; then dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true; fi
}

# identity <sessionId>: explicit first-boot identity reset.
# Forks restore onto pre-booted pool machines, so boot-time units never run. A sandbox whose
# marker names another session (a fork of a golden or of a live session) is scrubbed with the same
# script as the golden, gets a fresh machine-id and SSH host keys, and the strip-list check must pass.
# Re-running for the same session is a no-op, so a retried `cloud new` never wipes a working install.
step_identity() {
  local session="$1" marker="$RP_STATE/session-id" previous="" reset=false
  [ -f "$marker" ] && previous="$(cat "$marker")"
  if [ "$previous" != "$session" ]; then
    sudo U="$(id -un)" bash "$RP_SCRIPTS/golden-scrub.sh" >"$RP_STATE/identity.log" 2>&1
    sudo /usr/local/sbin/rp-firstboot-identity >>"$RP_STATE/identity.log" 2>&1
    reset=true
  fi
  printf '%s' "$session" >"$marker"
  result "$(python3 -c 'import json,sys
mid=open("/etc/machine-id").read().strip()
print(json.dumps({"ok":True,"reset":sys.argv[1]=="true","previousSession":sys.argv[2] or None,"machineId":mid}))' "$reset" "$previous")"
}

# tailscale-install: install Tailscale when the image lacks it, start tailscaled.
step_tailscale_install() {
  local installed=false state
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL --proto =https --proto-redir =https https://tailscale.com/install.sh | sudo sh >"$RP_STATE/tailscale-install.log" 2>&1
    installed=true
  fi
  sudo systemctl enable --now tailscaled >/dev/null 2>&1
  state="$(wait_for_tailscaled)" || fail "tailscaled did not start"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"installed":sys.argv[1]=="true","backendState":sys.argv[2],"version":sys.argv[3]}))' \
    "$installed" "$state" "$(tailscale version | head -1)")"
}

# check: the golden strip-list check in fork mode (run after identity reset, before joining).
step_check() {
  local out rc=0
  out="$(sudo U="$(id -un)" bash "$RP_SCRIPTS/golden-check.sh" fork 2>&1)" || rc=$?
  printf '%s\n' "$out" >"$RP_STATE/check.log"
  result "$(python3 -c 'import json,sys
lines=sys.argv[2].splitlines()
print(json.dumps({"ok":sys.argv[1]=="0","failed":[l[5:] for l in lines if l.startswith("FAIL ")],"passed":sum(1 for l in lines if l.startswith("PASS "))}))' "$rc" "$out")"
}

# tailscale-up <authKeyFile> <hostname>: join with a single-use tagged key. Never --ssh.
# The key file is shredded whether or not the join works.
# Tailscale state guard. After a boat stop/resume, /var/lib/tailscale/tailscaled.state sometimes comes
# back as 2 bytes (seen in 2 of 5 stop/resume cycles) and the node is logged out; a coordinator or peer wake
# can't repair that. tailscaled writes the state with temp-file-then-rename; files written in place survive
# boat's snapshots. So: keep an in-place copy (cp, never rename) in /var/lib/rp-ts-backup, refreshed every
# 60 s, whenever the state changes, and by the daemon's safe-to-stop flush; restore it before tailscaled
# starts when the state is missing, tiny or not JSON.
install_ts_state_guard() {
  sudo tee /usr/local/sbin/rp-tailscale-state >/dev/null <<'GUARD'
#!/bin/sh
# rp-tailscale-state backup|restore|forget : keep tailscaled.state recoverable across boat stop/resume.
STATE="${RP_TS_STATE:-/var/lib/tailscale/tailscaled.state}"
DIR="${RP_TS_BACKUP_DIR:-/var/lib/rp-ts-backup}"
BACKUP="$DIR/tailscaled.state"
# Every action is also appended (in place) to events.log beside the backup, which survives resumes.
say() { echo "rp-tailscale-state: $*"; mkdir -p "$DIR" && echo "$(date -u +%FT%TZ) boot=$(cut -c1-8 /proc/sys/kernel/random/boot_id) $*" >> "$DIR/events.log"; }
valid() { [ -f "$1" ] && [ "$(stat -c %s "$1")" -ge 100 ] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null; }
case "${1:-}" in
  backup)
    valid "$STATE" || { say "backup skipped: state missing or invalid ($(stat -c %s "$STATE" 2>/dev/null || echo missing) bytes)"; exit 0; }
    [ -f "$BACKUP" ] && cmp -s "$STATE" "$BACKUP" && exit 0
    mkdir -p "$DIR" && chmod 700 "$DIR"
    # cp into the existing file writes it in place: no temp file, no rename.
    [ -f "$BACKUP" ] || { : > "$BACKUP" && chmod 600 "$BACKUP"; }
    cp "$STATE" "$BACKUP" && chmod 600 "$BACKUP" && sync "$BACKUP" 2>/dev/null
    say "backed up ($(stat -c %s "$BACKUP") bytes)" ;;
  restore)
    valid "$STATE" && { say "restore check: state ok ($(stat -c %s "$STATE") bytes)"; exit 0; }
    valid "$BACKUP" || { say "restore check: state invalid and no valid backup"; exit 0; }
    mkdir -p "$(dirname "$STATE")"
    cp "$BACKUP" "$STATE" && chmod 600 "$STATE" && sync "$STATE" 2>/dev/null
    say "RESTORED tailscaled.state from backup ($(stat -c %s "$STATE") bytes)" ;;
  forget) rm -f "$BACKUP"; say "backup removed" ;;
  *) echo "usage: rp-tailscale-state backup|restore|forget" >&2; exit 2 ;;
esac
GUARD
  sudo chmod 755 /usr/local/sbin/rp-tailscale-state
  sudo tee /etc/systemd/system/rp-tailscale-state-restore.service >/dev/null <<'UNIT'
[Unit]
Description=Runpane Cloud: restore tailscaled.state from its backup when a resume lost it
DefaultDependencies=no
After=local-fs.target rp-firstboot-identity.service
Before=tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rp-tailscale-state restore

[Install]
WantedBy=tailscaled.service multi-user.target
UNIT
  sudo tee /etc/systemd/system/rp-tailscale-state-backup.service >/dev/null <<'UNIT'
[Unit]
Description=Runpane Cloud: copy tailscaled.state in place to /var/lib/rp-ts-backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rp-tailscale-state backup
UNIT
  sudo tee /etc/systemd/system/rp-tailscale-state-backup.timer >/dev/null <<'UNIT'
[Unit]
Description=Runpane Cloud: back up tailscaled.state every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
  sudo tee /etc/systemd/system/rp-tailscale-state-backup.path >/dev/null <<'UNIT'
[Unit]
Description=Runpane Cloud: back up tailscaled.state when it changes

[Path]
PathChanged=/var/lib/tailscale/tailscaled.state
Unit=rp-tailscale-state-backup.service

[Install]
WantedBy=paths.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable rp-tailscale-state-restore.service >/dev/null 2>&1 || fail "could not enable rp-tailscale-state-restore.service"
  sudo systemctl enable --now rp-tailscale-state-backup.timer rp-tailscale-state-backup.path >/dev/null 2>&1 \
    || fail "could not enable the tailscaled.state backup units"
  sudo /usr/local/sbin/rp-tailscale-state backup >/dev/null
}

# Serve guard. Tailscale keeps its Serve config inside tailscaled.state, and a resume has brought back a
# valid but STALE state without it (seen live: Running, same node, cert cached, "No serve config",
# so the daemon was unreachable). The desired config lives in /etc/rp-cloud/serve.json (written in place)
# and rp-serve-restore re-applies it on every boot, and on demand, when `tailscale serve status` lacks it.
install_serve_guard() {
  local transport="$1" port
  case "$transport" in https|http) ;; *) fail "serve guard: transport must be https or http" ;; esac
  port="$(pane_listen_port)"
  sudo mkdir -p /etc/rp-cloud /var/lib/rp-cloud
  printf '{"transport":"%s","port":%s}\n' "$transport" "$port" | sudo tee /etc/rp-cloud/serve.json >/dev/null
  sudo tee /usr/local/sbin/rp-serve-restore >/dev/null <<'GUARD'
#!/bin/sh
# rp-serve-restore: re-apply this cloud Session's Tailscale Serve config when it is missing.
CONF="${RP_SERVE_CONF:-/etc/rp-cloud/serve.json}"
LOG="${RP_SERVE_LOG:-/var/lib/rp-cloud/serve-events.log}"
say() { echo "rp-serve-restore: $*"; mkdir -p "$(dirname "$LOG")" && echo "$(date -u +%FT%TZ) boot=$(cut -c1-8 /proc/sys/kernel/random/boot_id) $*" >> "$LOG"; }
[ -f "$CONF" ] || { say "no $CONF; nothing to restore"; exit 0; }
transport=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["transport"])' "$CONF") || exit 1
port=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$CONF") || exit 1
if [ "$transport" = http ]; then want="$port"; else want=443; fi
i=0
until [ "$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("BackendState"))' 2>/dev/null)" = Running ]; do
  i=$((i+1)); [ "$i" -ge 90 ] && { say "tailscale not Running after 90 s; serve not checked"; exit 0; }
  sleep 1
done
if tailscale serve status --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin) or {};sys.exit(0 if sys.argv[1] in (d.get("TCP") or {}) else 1)' "$want" 2>/dev/null; then
  say "serve ok ($transport :$want)"; exit 0
fi
if [ "$transport" = http ]; then
  tailscale serve --bg --tcp="$port" "tcp://127.0.0.1:$port" >/dev/null 2>&1 || { say "FAILED to re-apply http serve :$port"; exit 1; }
else
  tailscale serve --bg --tls-terminated-tcp=443 "tcp://127.0.0.1:$port" >/dev/null 2>&1 || { say "FAILED to re-apply https serve"; exit 1; }
fi
say "RE-APPLIED missing serve config ($transport :$want -> 127.0.0.1:$port)"
GUARD
  sudo chmod 755 /usr/local/sbin/rp-serve-restore
  sudo tee /etc/systemd/system/rp-serve-restore.service >/dev/null <<'UNIT'
[Unit]
Description=Runpane Cloud: re-apply the Session's Tailscale Serve config if a resume lost it
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rp-serve-restore
TimeoutStartSec=150

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable rp-serve-restore.service >/dev/null 2>&1 || fail "could not enable rp-serve-restore.service"
}

# serve-guard <https|http>: record the desired Serve config, install the boot-time restore, and apply it now if
# it is missing. Idempotent; safe on a live Session (it never stops anything).
step_serve_guard() {
  local out applied=false
  install_serve_guard "$1"
  out="$(sudo /usr/local/sbin/rp-serve-restore 2>&1 | tail -1 || true)"
  case "$out" in *RE-APPLIED*) applied=true ;; *FAILED*|*"not Running"*) fail "$out" ;; esac
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"applied":sys.argv[1]=="true","detail":sys.argv[2]}))' "$applied" "$out")"
}

# ts-guard: (re)install the tailscaled.state guard on a node that is already joined (idempotent).
step_ts_guard() {
  install_ts_state_guard
  sudo test -s /var/lib/rp-ts-backup/tailscaled.state || fail "no tailscaled.state backup after installing the guard"
  result '{"ok":true}'
}

step_tailscale_up() {
  local keyfile="$1" hostname="$2" state
  RP_KEYFILE="$keyfile"
  trap 'shred -u "$RP_KEYFILE" 2>/dev/null || rm -f "$RP_KEYFILE"' EXIT
  chmod 600 "$keyfile"
  state="$(tailscale_backend_state)"
  if [ "$state" = Running ]; then fail "tailscale is already joined; use the re-enrol repair path"; fi
  sudo tailscale up --auth-key="file:$keyfile" --hostname="$hostname" --ssh=false >"$RP_STATE/tailscale-up.log" 2>&1 \
    || fail "tailscale up failed: $(tail -3 "$RP_STATE/tailscale-up.log" | tr '\n' ' ')"
  install_ts_state_guard
  result "$(tailnet_identity_json)"
}

# tailnet-identity: current tailnet identity (read-only). A wake's repair runs it while the box may still
# be booting, so it waits for tailscaled to answer and settle (the caller re-enrols anything not Running).
step_tailnet_identity() {
  wait_for_settled_tailscaled >/dev/null || fail "tailscaled is not answering"
  result "$(tailnet_identity_json)"
}

# tailscale-reset: repair path, sandbox side. The caller deletes the old device through the API FIRST
# (rejoining without that gives a -1 suffixed name). Wipes node state so the next `up` enrols fresh.
step_tailscale_reset() {
  sudo systemctl stop tailscaled
  sudo rm -f /var/lib/tailscale/tailscaled.state
  # The backup holds the identity being thrown away: a restore at the next boot must not bring it back.
  sudo rm -f /var/lib/rp-ts-backup/tailscaled.state
  sudo systemctl start tailscaled
  local state
  state="$(wait_for_tailscaled)" || fail "tailscaled did not restart"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"backendState":sys.argv[1]}))' "$state")"
}

# serve-restore: Tailscale Serve config lives in tailscaled's state, so a re-enrol loses it.
# Re-point :443 (TLS terminated by Tailscale) at the daemon's loopback port.
step_serve_restore() {
  local port
  port="$(pane_listen_port)"
  if pane_access_base_url | grep -q '^http://'; then
    # This host serves plain TCP inside the tailnet (no TLS certificate): restore that, not HTTPS.
    sudo tailscale serve --bg --tcp="$port" "tcp://127.0.0.1:$port" >"$RP_STATE/serve.log" 2>&1 \
      || fail "tailscale serve --tcp failed: $(tail -3 "$RP_STATE/serve.log" | tr '\n' ' ')"
  else
    sudo tailscale serve --bg --tls-terminated-tcp=443 "$port" >"$RP_STATE/serve.log" 2>&1 \
      || fail "tailscale serve failed: $(tail -3 "$RP_STATE/serve.log" | tr '\n' ' ')"
  fi
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"listenPort":int(sys.argv[1])}))' "$port")"
}

pane_access_base_url() {
  python3 - "$HOME/.pane_remote/config.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
print((((d.get("remoteDaemon") or {}).get("host") or {}).get("access") or {}).get("baseUrl") or "")
PY
}

# cert-status <fqdn>: did Let's Encrypt refuse this tailnet's Serve certificate (50 per registered domain per
# week; every new node name needs one)? Informational: `auto` switches whenever HTTPS stays down while the
# daemon answers on loopback, and this names the reason. tailscaled logs the ACME error when a TLS client
# (the health probe) asks for the certificate; this boot only (a node is young when this runs).
step_cert_status() {
  local fqdn="$1" hit=""
  # set -o pipefail: a grep with no match must not end the step.
  hit="$(sudo journalctl -b -u tailscaled --no-pager -o cat 2>/dev/null | grep -iE 'rateLimited|too many certificates|acme.*429' | tail -1 || true)"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"rateLimited":bool(sys.argv[1]),"detail":sys.argv[1][:300] or None}))' "$hit")"
}

# serve-http: plain HTTP inside the tailnet (WireGuard encrypts it) when no TLS certificate can be had.
# Tailscale Serve forwards tcp :<port> on the node to the daemon on loopback; the daemon's advertised
# access URL becomes http://<fqdn>:<port> so peer codes it mints point there too.
step_serve_http() {
  local port fqdn base
  port="$(pane_listen_port)"
  fqdn="$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')" \
    || fail "could not read this node's MagicDNS name"
  sudo tailscale serve --bg --tcp="$port" "tcp://127.0.0.1:$port" >"$RP_STATE/serve-http.log" 2>&1 \
    || fail "tailscale serve --tcp failed: $(tail -3 "$RP_STATE/serve-http.log" | tr '\n' ' ')"
  base="http://$fqdn:$port"
  install_serve_guard http
  systemctl --user stop pane-remote-daemon.service
  python3 - "$HOME/.pane_remote/config.json" "$base" "$port" <<'PY' || fail "could not record the http access URL"
import datetime, json, os, sys
path, base, port = sys.argv[1:4]
d = json.load(open(path))
host = d.setdefault("remoteDaemon", {}).setdefault("host", {})
host["access"] = {
  "baseUrl": base,
  "tunnel": {"kind": "tailscale", "selected": True,
             "note": f"Tailscale Serve TCP on :{port}, plain HTTP inside the tailnet (no TLS certificate available)"},
  "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
}
# In place, not temp+rename: boat snapshots have lost a renamed tailscaled.state. The daemon is stopped.
with open(path, "r+") as out:
    out.seek(0)
    json.dump(d, out, indent=2)
    out.truncate()
    out.flush()
    os.fsync(out.fileno())
PY
  systemctl --user start pane-remote-daemon.service
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"baseUrl":sys.argv[1]}))' "$base")"
}

# install-pane <mode> <debUrl> <debSha256> <runpaneSpec> <label>
#   mode: deb-url (install the given .deb, e.g. a pre-release build), preinstalled (the golden image has /opt/Pane),
#         runpane-npm (`runpane install daemon --format deb` downloads the release .deb; <runpaneSpec> picks the CLI).
# With Pane already on disk, setup calls `pane --remote-setup` directly, as `runpane install daemon` does after it
# resolves and downloads the upstream .deb it then ignores. Setup output (which carries the pairing code) goes to a
# 0600 log; the code is moved into pairing.code and redacted from the log.
step_install_pane() {
  local mode="$1" deb_url="$2" deb_sha="$3" spec="$4" label="$5" rc=0 code
  if [ -s "$RP_STATE/pairing.code" ] && systemctl --user is-active -q pane-remote-daemon.service; then
    result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"skipped":True,"version":sys.argv[1] or None,"listenPort":int(sys.argv[2])}))' "$(pane_version)" "$(pane_listen_port)")"
    return 0
  fi
  case "$mode" in
    deb-url)
      case "$deb_url" in https://*) ;; *) fail "the Pane .deb URL must be https://" ;; esac
      curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$RP_STATE/pane.deb" "$deb_url" || fail "download of the Pane .deb failed"
      if [ -n "$deb_sha" ]; then
        echo "$deb_sha  $RP_STATE/pane.deb" | sha256sum -c --status || fail "Pane .deb sha256 mismatch"
      fi
      chmod 644 "$RP_STATE/pane.deb"
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$RP_STATE/pane.deb" >"$RP_STATE/pane-deb.log" 2>&1 \
        || fail "apt-get install of the Pane .deb failed: $(tail -3 "$RP_STATE/pane-deb.log" | tr '\n' ' ')"
      rm -f "$RP_STATE/pane.deb"
      ;;
    preinstalled)
      [ -x /opt/Pane/pane ] || fail "no Pane in the image (/opt/Pane/pane missing)"
      ;;
    runpane-npm) ;;
    *) fail "unknown pane source $mode" ;;
  esac
  sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  # Pane's setup runs `tailscale serve` as this user; make it the node's operator (no other rights).
  sudo tailscale set --operator="$(id -un)" >/dev/null 2>&1 || fail "tailscale set --operator failed"
  if [ "$mode" = runpane-npm ]; then
    npx --yes --package="$spec" runpane install daemon --format deb --prefer-tunnel tailscale --auto-listen-port \
      --label "$label" >"$RP_STATE/install.log" 2>&1 || rc=$?
  else
    ELECTRON_OZONE_PLATFORM_HINT=headless /opt/Pane/pane --ozone-platform=headless --disable-gpu --remote-setup \
      --prefer-tunnel tailscale --auto-listen-port --label "$label" >"$RP_STATE/install.log" 2>&1 || rc=$?
  fi
  code="$(awk '/^Connection code:/{getline; print; exit}' "$RP_STATE/install.log" | tr -d '\r')"
  sed -i -E 's#pane-remote://[^[:space:]]*#<pairing-redacted>#g' "$RP_STATE/install.log"
  if [ "$rc" -ne 0 ]; then fail "Pane remote setup exited $rc: $(tail -5 "$RP_STATE/install.log" | tr '\n' ' ')"; fi
  case "$code" in
    pane-remote://*) printf '%s' "$code" >"$RP_STATE/pairing.code"; chmod 600 "$RP_STATE/pairing.code" ;;
    *) fail "Pane remote setup printed no pane-remote:// connection code" ;;
  esac
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"skipped":False,"version":sys.argv[1] or None,"listenPort":int(sys.argv[2])}))' "$(pane_version)" "$(pane_listen_port)")"
}

# add-client <slug> <label>: add another paired client (e.g. the coordinator's) to the running daemon.
# `pane --remote-setup` upserts a new client record each run; the daemon is restarted to load it.
# The code goes to $RP_STATE/client-<slug>.code (0600) and is read back with pairing-read <slug>.
step_add_client() {
  local slug="$1" label="$2" scope="${3:-}" rc=0 code log="$RP_STATE/client-$1.log"
  local scope_args=()
  [ -x /opt/Pane/pane ] || fail "Pane is not installed"
  # A scoped client (the coordinator) must never silently fall back to full access on an older Pane.
  if [ -n "$scope" ]; then scope_args=(--client-scope "$scope"); fi
  # Keep the running daemon's port: --auto-listen-port would see it busy and move the daemon.
  /opt/Pane/pane --ozone-platform=headless --disable-gpu --remote-setup --label "$label" --prefer-tunnel tailscale \
    --no-install-service --listen-port "$(pane_listen_port)" "${scope_args[@]}" >"$log" 2>&1 || rc=$?
  code="$(awk '/^Connection code:/{getline; print; exit}' "$log" | tr -d '\r')"
  sed -i -E 's#pane-remote://[^[:space:]]*#<pairing-redacted>#g' "$log"
  [ "$rc" -eq 0 ] || fail "pane --remote-setup exited $rc: $(tail -5 "$log" | tr '\n' ' ')"
  if [ -n "$scope" ] && ! python3 - "$HOME/.pane_remote/config.json" "$label" "$scope" <<'PY'
import json, os, sys
path, label, scope = sys.argv[1:4]
doc = json.load(open(path))
clients = doc["remoteDaemon"]["host"]["clients"]
mine = [c for c in clients if c.get("label") == label]
if mine and mine[-1].get("scope") == scope:
    sys.exit(0)
# An older Pane ignored --client-scope and paired a full-access client: take it back out.
doc["remoteDaemon"]["host"]["clients"] = [c for c in clients if not (c.get("label") == label and c.get("scope") != scope)]
tmp = path + ".rp-tmp"
with open(tmp, "w") as out:
    json.dump(doc, out, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
sys.exit(1)
PY
  then
    fail "this Pane build cannot pair a $scope-scoped client (it ignores --client-scope); removed the full-access $label record instead"
  fi
  case "$code" in
    pane-remote://*) printf '%s' "$code" >"$RP_STATE/client-$slug.code"; chmod 600 "$RP_STATE/client-$slug.code" ;;
    *) fail "pane --remote-setup printed no connection code" ;;
  esac
  systemctl --user restart pane-remote-daemon.service
  result '{"ok":true}'
}

# pairing-read [slug]: prints the pairing code inside the result (the caller keeps it in memory and writes it
# to a local 0600 file). The only step whose output carries a secret; the caller never logs it.
step_pairing_read() {
  local file="$RP_STATE/pairing.code"
  [ -n "${1:-}" ] && file="$RP_STATE/client-$1.code"
  [ -s "$file" ] || fail "no pairing code"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"code":open(sys.argv[1]).read().strip()}))' "$file")"
}

# health-local: GET /health on the daemon's loopback port (diagnostics; readiness is checked over the tailnet).
step_health_local() {
  local port body
  port="$(pane_listen_port)"
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null)" || fail "daemon /health on 127.0.0.1:$port failed"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"listenPort":int(sys.argv[1]),"health":json.loads(sys.argv[2])}))' "$port" "$body")"
}

# firewall <tcp ports csv>: only these TCP ports (default Tailscale Serve's 443) are reachable over the tailnet.
# The tailnet policy lets rp-session nodes reach each other on every port, which exposes the provider's own
# in-sandbox services (desktop stream, agent service, sshd) to a compromised peer. Idempotent; the rules live
# in /etc and a oneshot unit reloads them at boot, so they survive stop/resume (a resume is a fresh boot).
step_firewall() {
  local ports="${1:-443}" port elements="" nft
  for port in ${ports//,/ }; do
    case "$port" in ''|*[!0-9]*) fail "firewall: bad port '$port'" ;; esac
    elements="${elements:+$elements, }$port"
  done
  [ -n "$elements" ] || fail "firewall: no ports"
  if ! command -v nft >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q nftables >"$RP_STATE/nftables-install.log" 2>&1 \
      || fail "installing nftables failed: $(tail -2 "$RP_STATE/nftables-install.log" | tr '\n' ' ')"
  fi
  nft="$(command -v nft)"
  sudo tee /etc/rp-tailnet-firewall.nft >/dev/null <<NFT
#!$nft -f
# Runpane Cloud: over the tailnet, only tcp {$elements} (Tailscale Serve) and replies reach this sandbox.
table inet rp_tailnet
delete table inet rp_tailnet
table inet rp_tailnet {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "tailscale0" ct state established,related accept
    iifname "tailscale0" tcp dport { $elements } accept
    iifname "tailscale0" counter drop
  }
}
NFT
  sudo tee /etc/systemd/system/rp-tailnet-firewall.service >/dev/null <<UNIT
[Unit]
Description=Runpane Cloud tailnet firewall (tcp $elements only over tailscale0)
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target tailscaled.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nft -f /etc/rp-tailnet-firewall.nft
ExecStop=$nft delete table inet rp_tailnet

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable rp-tailnet-firewall.service >/dev/null 2>&1 || fail "could not enable rp-tailnet-firewall.service"
  sudo systemctl restart rp-tailnet-firewall.service || fail "rp-tailnet-firewall.service failed: $(sudo systemctl status rp-tailnet-firewall.service --no-pager 2>&1 | tail -3 | tr '\n' ' ')"
  sudo "$nft" list table inet rp_tailnet >/dev/null 2>&1 || fail "the rp_tailnet table is not loaded"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"allowedTcp":[int(p) for p in sys.argv[1].split(",") if p]}))' "$ports")"
}

# clone <url> <ref> <dir>: public HTTPS clone (no credentials in the sandbox). Idempotent.
# <ref> is fetched from origin every time and must be: the checkout is the commit that fetch returned, never a
# stale local branch or an older FETCH_HEAD. A branch is checked out as a local branch reset to that commit.
step_clone() {
  local url="$1" ref="$2" dir="$3" fresh
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$(dirname "$dir")"
    GIT_TERMINAL_PROMPT=0 git clone -q "$url" "$dir" 2>"$RP_STATE/clone.log" || fail "git clone failed: $(tail -2 "$RP_STATE/clone.log" | tr '\n' ' ')"
  fi
  if [ -n "$ref" ]; then
    GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch -q origin "$ref" 2>>"$RP_STATE/clone.log" \
      || fail "git fetch of $ref failed: $(tail -2 "$RP_STATE/clone.log" | tr '\n' ' ')"
    fresh="$(git -C "$dir" rev-parse --verify -q 'FETCH_HEAD^{commit}')" || fail "git fetch of $ref returned no commit"
    if [ "$(git -C "$dir" rev-parse --verify -q "refs/remotes/origin/$ref^{commit}" 2>/dev/null || true)" = "$fresh" ]; then
      git -C "$dir" checkout -q -B "$ref" "$fresh" 2>>"$RP_STATE/clone.log" || fail "git checkout $ref failed"
      git -C "$dir" branch -q --set-upstream-to="origin/$ref" "$ref" 2>>"$RP_STATE/clone.log" || true
    else
      git -C "$dir" checkout -q --detach "$fresh" 2>>"$RP_STATE/clone.log" || fail "git checkout $ref failed"
    fi
    [ "$(git -C "$dir" rev-parse HEAD)" = "$fresh" ] || fail "git checkout $ref did not land on the fetched $fresh"
  fi
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"dir":sys.argv[1],"head":sys.argv[2]}))' "$dir" "$(git -C "$dir" rev-parse HEAD)")"
}

step="${1:-}"; shift || true
case "$step" in
  identity) step_identity "$@" ;;
  tailscale-install) step_tailscale_install ;;
  check) step_check ;;
  tailscale-up) step_tailscale_up "$@" ;;
  tailnet-identity) step_tailnet_identity ;;
  tailscale-reset) step_tailscale_reset ;;
  serve-restore) step_serve_restore ;;
  install-pane) step_install_pane "$@" ;;
  add-client) step_add_client "$@" ;;
  pairing-read) step_pairing_read "$@" ;;
  health-local) step_health_local ;;
  clone) step_clone "$@" ;;
  firewall) step_firewall "$@" ;;
  ts-guard) step_ts_guard ;;
  cert-status) step_cert_status "$@" ;;
  serve-http) step_serve_http ;;
  serve-guard) step_serve_guard "$@" ;;
  *) fail "unknown step '$step'" ;;
esac
