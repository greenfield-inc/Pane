#!/bin/bash
# rp-bootstrap.sh: sandbox-side provisioning steps for a Pane cloud sandbox.
# Uploaded and run by packages/runpane/src/cloud/bootstrap/provision.ts
# as the sandbox login user, one step per call:  bash rp-bootstrap.sh <step> [args...]
#
# Every step ends with one line `RP_RESULT <json>` that the caller parses.
# No step prints a secret: the Tailscale auth key and the agent environment are read from 0600 files
# (the key is shredded), and the pane-remote:// pairing code only lands in $RP_STATE/pairing.code (0600).
# pairing-read is the one step whose result carries it; the caller keeps it in memory and never logs it.
set -euo pipefail
umask 077

RP_STATE="${RP_STATE:-$HOME/.runpane-cloud}"
RP_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$RP_STATE"
chmod 700 "$RP_STATE"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# Where the startup script's runner and boot unit go (tests point these at a temp dir).
RP_UNIT_DIR="${RP_UNIT_DIR:-/etc/systemd/system}"
RP_SBIN="${RP_SBIN:-/usr/local/sbin}"
RP_ETC="${RP_ETC:-/etc}"

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

# The state tailscaled settles into. Right after a boot or a Start it passes NoState and Starting within its
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
# Sandboxes restore onto pre-booted pool machines, so boot-time units never run. A sandbox whose
# marker names another session is scrubbed, gets a fresh machine-id and SSH host keys, and the
# strip-list check (identity-check.sh) must pass before it joins the tailnet.
# Re-running for the same session is a no-op, so a retried `cloud new` never wipes a working install.
step_identity() {
  local session="$1" marker="$RP_STATE/session-id" previous="" reset=false
  [ -f "$marker" ] && previous="$(cat "$marker")"
  if [ "$previous" != "$session" ]; then
    sudo U="$(id -un)" bash "$RP_SCRIPTS/identity-scrub.sh" >"$RP_STATE/identity.log" 2>&1
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

# check: the identity strip-list check (run after the identity reset, before joining).
step_check() {
  local out rc=0
  out="$(sudo U="$(id -un)" bash "$RP_SCRIPTS/identity-check.sh" 2>&1)" || rc=$?
  printf '%s\n' "$out" >"$RP_STATE/check.log"
  result "$(python3 -c 'import json,sys
lines=sys.argv[2].splitlines()
print(json.dumps({"ok":sys.argv[1]=="0","failed":[l[5:] for l in lines if l.startswith("FAIL ")],"passed":sum(1 for l in lines if l.startswith("PASS "))}))' "$rc" "$out")"
}

# Tailscale state guard. After a boat stop/resume, /var/lib/tailscale/tailscaled.state sometimes comes
# back as 2 bytes (seen in 2 of 5 stop/resume cycles) and the node is logged out; Start can then only
# re-enrol it as a new node. tailscaled writes the state with temp-file-then-rename; files written in place
# survive boat's snapshots. So: keep an in-place copy (cp, never rename) in /var/lib/rp-ts-backup, refreshed
# every 60 s and whenever the state changes; restore it before tailscaled starts when the state is missing,
# tiny or not JSON.
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
Description=Pane cloud sandbox: restore tailscaled.state from its backup when a resume lost it
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
Description=Pane cloud sandbox: copy tailscaled.state in place to /var/lib/rp-ts-backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rp-tailscale-state backup
UNIT
  sudo tee /etc/systemd/system/rp-tailscale-state-backup.timer >/dev/null <<'UNIT'
[Unit]
Description=Pane cloud sandbox: back up tailscaled.state every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
  sudo tee /etc/systemd/system/rp-tailscale-state-backup.path >/dev/null <<'UNIT'
[Unit]
Description=Pane cloud sandbox: back up tailscaled.state when it changes

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
# rp-serve-restore: re-apply this cloud sandbox's Tailscale Serve config when it is missing.
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
Description=Pane cloud sandbox: re-apply the sandbox's Tailscale Serve config if a resume lost it
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
# it is missing. Idempotent; safe on a running sandbox (it never stops anything).
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

# tailscale-up <authKeyFile> <hostname>: join with a single-use tagged key. Never --ssh.
# The key file is shredded whether or not the join works.
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

# tailnet-identity: current tailnet identity (read-only). A Start's repair runs it while the box may still
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
# access URL becomes http://<fqdn>:<port> so pairing codes it mints point there too.
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

# agent-env <envFile>: agents sign in from this 0600 environment file (e.g. CLAUDE_CODE_OAUTH_TOKEN). A drop-in hands
# it to the Pane daemon's user unit, so agent panels inherit it; the value is never on a command line or in output.
# Runs before install-pane, so the daemon starts with it.
step_agent_env() {
  local envfile="$1" dropin="$HOME/.config/systemd/user/pane-remote-daemon.service.d"
  [ -s "$envfile" ] || fail "agent-env: no environment file"
  chmod 600 "$envfile"
  mkdir -p "$dropin"
  printf '[Service]\nEnvironmentFile=%s\n' "$envfile" >"$dropin/runpane-cloud-agent.conf"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  result '{"ok":true}'
}

# Claude Code asks, in an agent panel nobody is watching yet, whether to trust the folder (the default answer exits)
# and whether to accept bypass-permissions mode. Answer both for this user's home, every git repository under it and
# their worktrees (Pane puts them in <repo>/worktrees; a trusted repository covers worktrees made later). Merged into
# the existing ~/.claude.json and ~/.claude/settings.json and written atomically (same mode); a file that is not JSON
# is left alone and the step fails. A repository added after this ran is covered by CLAUDE_CODE_SANDBOXED (install_agent_dropins).
seed_claude_prompts() {
  python3 - "$HOME" <<'PY'
import json, os, sys
home = sys.argv[1]
os.umask(0o077)

def load(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} is not a JSON object")
    return data

def save(path, data):
    # Atomic: a temp file beside it, same mode, fsynced, then renamed over it. A crash never leaves half a file.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    temp = f"{path}.rp-{os.getpid()}.tmp"
    with open(temp, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)

trusted = [home]
for root, dirs, _ in os.walk(home):
    depth = root[len(home):].count(os.sep)
    dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
    if ".git" in os.listdir(root) and root != home:
        trusted.append(root)
        worktrees = os.path.join(root, "worktrees")
        if os.path.isdir(worktrees):
            trusted += [os.path.join(worktrees, d) for d in sorted(os.listdir(worktrees)) if os.path.isdir(os.path.join(worktrees, d))]
    if depth >= 3:
        dirs[:] = []

path = os.path.join(home, ".claude.json")
data = load(path)
data["hasCompletedOnboarding"] = True
data["bypassPermissionsModeAccepted"] = True
projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
for folder in trusted:
    entry = projects.get(folder) if isinstance(projects.get(folder), dict) else {}
    entry["hasTrustDialogAccepted"] = True
    projects[folder] = entry
data["projects"] = projects
save(path, data)

settings_path = os.path.join(home, ".claude", "settings.json")
settings = load(settings_path)
settings["skipDangerousModePermissionPrompt"] = True
save(settings_path, settings)
print(len(trusted))
PY
}

# Environment for the Pane daemon, so its agent panels inherit it:
# - PANE_RESUME_AGENTS_ON_START: after a stop/start, the daemon relaunches the agent panels a stop interrupted.
# - CLAUDE_CODE_SANDBOXED: Claude Code treats every folder of this disposable sandbox as trusted. Its trust dialog
#   does not follow ~/.claude.json's home entry into a repository added later (seen live with Claude Code 2.1.287),
#   and its default answer exits the agent.
install_agent_dropins() {
  local dir="$HOME/.config/systemd/user/pane-remote-daemon.service.d"
  mkdir -p "$dir"
  printf '[Service]\nEnvironment=PANE_RESUME_AGENTS_ON_START=1\n' >"$dir/resume-agents.conf"
  printf '[Service]\nEnvironment=CLAUDE_CODE_SANDBOXED=1\n' >"$dir/claude-sandboxed.conf"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

# agent-prompts: pre-answer Claude Code's folder-trust and bypass-permissions prompts (see seed_claude_prompts).
step_agent_prompts() {
  local trusted
  trusted="$(seed_claude_prompts 2>"$RP_STATE/agent-prompts.log")" || fail "agent-prompts: $(tail -1 "$RP_STATE/agent-prompts.log")"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"trustedFolders":int(sys.argv[1])}))' "$trusted")"
}

# install_pane_deb <https url> [sha256]: download (https only, also on redirects), verify and apt-install a Pane .deb.
install_pane_deb() {
  local deb_url="$1" deb_sha="${2:-}"
  case "$deb_url" in https://*) ;; *) fail "the Pane .deb URL must be https://" ;; esac
  curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$RP_STATE/pane.deb" "$deb_url" || fail "download of the Pane .deb failed"
  if [ -n "$deb_sha" ]; then
    echo "$deb_sha  $RP_STATE/pane.deb" | sha256sum -c --status || { rm -f "$RP_STATE/pane.deb"; fail "Pane .deb sha256 mismatch"; }
  fi
  chmod 644 "$RP_STATE/pane.deb"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades "$RP_STATE/pane.deb" >"$RP_STATE/pane-deb.log" 2>&1 \
    || fail "apt-get install of the Pane .deb failed: $(tail -3 "$RP_STATE/pane-deb.log" | tr '\n' ' ')"
  rm -f "$RP_STATE/pane.deb"
}

# update-pane <https url> <sha256>: install another Pane .deb on a provisioned sandbox and restart its daemon.
# Pairing, data and Serve are kept (they live outside the package); the daemon resumes its panels on start.
step_update_pane() {
  local deb_url="$1" deb_sha="$2"
  [[ "$deb_sha" =~ ^[0-9a-f]{64}$ ]] || fail "update-pane: sha256 must be 64 lowercase hex characters"
  [ -s "$RP_STATE/pairing.code" ] || fail "update-pane: this sandbox was never provisioned"
  install_pane_deb "$deb_url" "$deb_sha"
  # A reinstall re-lays what create set up for agents, in case an older bootstrap or a user removed it.
  seed_claude_prompts >/dev/null 2>"$RP_STATE/agent-prompts.log" || fail "update-pane: $(tail -1 "$RP_STATE/agent-prompts.log")"
  install_agent_dropins
  systemctl --user restart pane-remote-daemon.service || fail "could not restart pane-remote-daemon.service"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"version":sys.argv[1] or None}))' "$(pane_version)")"
}

# claude-model <model>: the model new Claude Code panels start with (`model` in ~/.claude/settings.json), so the
# sandbox follows the default of the user's own Claude Code. Not a pin: it only replaces a value it wrote itself
# (recorded in $RP_STATE/claude-model); a model chosen inside the sandbox (`/model`) is kept. Atomic, other keys kept.
# There is no "clear": when the user's default is unknown the caller sends nothing, so the sandbox keeps its model.
step_claude_model() {
  # A model id or alias as `claude --model` takes it: claude-opus-5-5, opus, claude-opus-5-5[1m].
  local wanted="$1" model_id='^[A-Za-z0-9][]A-Za-z0-9._:@/[-]{0,99}$'
  [[ "$wanted" =~ $model_id ]] || fail "claude-model: not a Claude model id"
  local out
  out="$(python3 - "$HOME" "$RP_STATE/claude-model" "$wanted" 2>"$RP_STATE/claude-model.log" <<'PY'
import json, os, sys
home, marker, wanted = sys.argv[1:4]
os.umask(0o077)
path = os.path.join(home, ".claude", "settings.json")
settings = {}
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
    if not isinstance(settings, dict):
        raise SystemExit(f"{path} is not a JSON object")
applied = open(marker).read().strip() if os.path.exists(marker) else None
current = settings.get("model")
if current is not None and current != applied:
    outcome = "kept-sandbox-choice"
else:
    outcome = "current" if current == wanted else "set"
    settings["model"] = wanted
if outcome == "set":
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    temp = f"{path}.rp-{os.getpid()}.tmp"
    with open(temp, "w") as f:
        json.dump(settings, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)
if outcome != "kept-sandbox-choice":
    with open(marker, "w") as f:
        f.write(wanted)
print(json.dumps({"ok": True, "outcome": outcome, "model": settings.get("model")}))
PY
)" || fail "claude-model: could not update ~/.claude/settings.json: $(tail -1 "$RP_STATE/claude-model.log")"
  result "$out"
}

# install-pane <mode> <debUrl> <debSha256> <runpaneSpec> <label>
#   mode: deb-url (install the given .deb, e.g. a pinned release), runpane-npm (`runpane install daemon --format deb`
#         downloads the release .deb; <runpaneSpec> picks the CLI).
# With a .deb installed, setup calls `pane --remote-setup` directly, as `runpane install daemon` does after its
# download. Setup output (which carries the pairing code) goes to a 0600 log; the code is moved into pairing.code
# and redacted from the log.
step_install_pane() {
  local mode="$1" deb_url="$2" deb_sha="$3" spec="$4" label="$5" rc=0 code
  # First, so a re-run on a provisioned sandbox (the skip below) lays the daemon's agent environment down again.
  install_agent_dropins
  if [ -s "$RP_STATE/pairing.code" ] && systemctl --user is-active -q pane-remote-daemon.service; then
    result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"skipped":True,"version":sys.argv[1] or None,"listenPort":int(sys.argv[2])}))' "$(pane_version)" "$(pane_listen_port)")"
    return 0
  fi
  case "$mode" in
    deb-url) install_pane_deb "$deb_url" "$deb_sha" ;;
    runpane-npm) ;;
    *) fail "unknown pane source $mode" ;;
  esac
  sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  # Pane commits a new project's first commit; a fresh sandbox has no git identity. Only set when missing.
  if command -v git >/dev/null 2>&1; then
    git config --global user.name >/dev/null 2>&1 || git config --global user.name "Pane cloud sandbox"
    git config --global user.email >/dev/null 2>&1 || git config --global user.email "pane@$(hostname)"
  fi
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

# pairing-read: prints the pairing code inside the result. The only step whose output carries a secret;
# the caller keeps it in memory and never logs it.
step_pairing_read() {
  local file="$RP_STATE/pairing.code"
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
# A tailnet policy may let other nodes reach this one on every port, which would expose the provider's own
# in-sandbox services (desktop stream, agent service, sshd) to any of them. Idempotent; the rules live
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
# Pane cloud sandbox: over the tailnet, only tcp {$elements} (Tailscale Serve) and replies reach this sandbox.
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
Description=Pane cloud sandbox tailnet firewall (tcp $elements only over tailscale0)
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

# The user's startup script (one per user, set in desktop Pane): ~/.config/runpane-cloud/startup.sh, run by
# rp-user-startup.service on every boot. It is a system unit run as the login user that nothing else waits for, so a
# slow or failing script never holds up the Pane daemon (a user unit). rp-user-startup.sh records its status and logs.
STARTUP_SCRIPT="$HOME/.config/runpane-cloud/startup.sh"
STARTUP_STATUS="$HOME/.local/state/runpane-cloud/startup-status.json"
STARTUP_UNIT=rp-user-startup.service
LOCAL_ENV="$HOME/.config/runpane-cloud/local-env"
LOCAL_ENV_LOADER="$HOME/.config/runpane-cloud/local-env.sh"

install_startup_unit() {
  sudo install -m 755 "$RP_SCRIPTS/rp-user-startup.sh" "$RP_SBIN/rp-user-startup"
  sudo tee "$RP_UNIT_DIR/$STARTUP_UNIT" >/dev/null <<UNIT
[Unit]
Description=Pane cloud sandbox: run the user's startup script (~/.config/runpane-cloud/startup.sh)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=$(id -un)
WorkingDirectory=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$RP_SBIN/rp-user-startup
TimeoutStartSec=660

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable "$STARTUP_UNIT" >/dev/null 2>&1 || fail "could not enable $STARTUP_UNIT"
}

# startup-install <uploaded script file | "">: install the boot unit, then make the uploaded file the startup script
# (0700, the login user's), or remove the script when no file is given. Never runs it. Idempotent.
step_startup_install() {
  local upload="${1:-}"
  install_startup_unit
  if [ -z "$upload" ]; then
    rm -f "$STARTUP_SCRIPT"
    result '{"ok":true,"sha256":null}'
    return
  fi
  [ -f "$upload" ] || fail "startup-install: no uploaded script"
  mkdir -p "$(dirname "$STARTUP_SCRIPT")"
  cat "$upload" >"$STARTUP_SCRIPT"
  rm -f "$upload"
  chmod 700 "$STARTUP_SCRIPT"
  chown "$(id -un):" "$STARTUP_SCRIPT"
  result "$(printf '{"ok":true,"sha256":"%s"}' "$(sha256sum "$STARTUP_SCRIPT" | cut -d' ' -f1)")"
}

# The latest status as JSON, or null when there is none (never ran, or unreadable).
startup_status_json() {
  python3 -c '
import json, sys
try:
    print(json.dumps(json.load(open(sys.argv[1]))))
except (OSError, ValueError):
    print("null")' "$STARTUP_STATUS"
}

# startup-run <always|if-changed>: start one run of the script without waiting for it (a boat command lasts at most
# 10 minutes, and so can the script); the caller follows it with startup-status. `busy`: a run (a boot run) is in
# progress, and systemd would merge a start into it, so ask again later. if-changed `skipped`: the last run used this
# script. Also `skipped` with no script.
step_startup_run() {
  local mode="${1:-}" state=skipped before
  case "$mode" in always|if-changed) ;; *) fail "startup-run: mode must be always or if-changed" ;; esac
  # Read before starting: the new run can write its own status before this step reports, and the caller tells its
  # run apart by a different startedAt.
  before="$(startup_status_json)"
  if [ "$(systemctl is-active "$STARTUP_UNIT" 2>/dev/null)" = activating ]; then
    state=busy
  elif [ -s "$STARTUP_SCRIPT" ]; then
    # if-changed: the last run used this script AND this local env (its sha, or none).
    if [ "$mode" = always ] || ! python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s.get("sha256")==sys.argv[2] and s.get("envSha256")==(sys.argv[3] or None) and s.get("finishedAt") else 1)' \
        "$STARTUP_STATUS" "$(sha256sum "$STARTUP_SCRIPT" | cut -d' ' -f1)" "$( [ -f "$LOCAL_ENV" ] && sha256sum "$LOCAL_ENV" | cut -d' ' -f1)" 2>/dev/null; then
      sudo systemctl start --no-block "$STARTUP_UNIT" || fail "could not start $STARTUP_UNIT"
      state=started
    fi
  fi
  result "{\"ok\":true,\"state\":\"$state\",\"status\":$before}"
}

# startup-status: whether the script runs now, and the latest status (null: none).
step_startup_status() {
  local active=false
  [ "$(systemctl is-active "$STARTUP_UNIT" 2>/dev/null)" = activating ] && active=true
  result "{\"ok\":true,\"active\":$active,\"status\":$(startup_status_json)}"
}

# startup-log: the last 200 lines of the latest run's log. Only the desktop's View log shows it; it may hold
# anything the user's script printed.
step_startup_log() {
  python3 -c '
import json, sys
try:
    lines = open(sys.argv[1], errors="replace").read().splitlines(True)[-200:]
except OSError:
    lines = []
print("RP_RESULT " + json.dumps({"ok": True, "log": "".join(lines)}))' "$HOME/.local/state/runpane-cloud/startup.log"
}

# os-hostname <name>: give the OS the sandbox's tailnet name (rp-…) now and at every boot. A boat resume brings back
# the pool machine's name (box-node-…); rp-hostname.sh puts this one back. Idempotent. Never touches Tailscale.
step_os_hostname() {
  local name="${1:-}"
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "os-hostname: not a hostname"
  sudo mkdir -p "$RP_ETC/rp-cloud"
  printf '%s\n' "$name" | sudo tee "$RP_ETC/rp-cloud/hostname" >/dev/null
  sudo install -m 755 "$RP_SCRIPTS/rp-hostname.sh" "$RP_SBIN/rp-hostname"
  sudo tee "$RP_UNIT_DIR/rp-hostname.service" >/dev/null <<UNIT
[Unit]
Description=Pane cloud sandbox: give the OS the sandbox's tailnet name after a resume reset it
Wants=network-online.target
After=network-online.target cloud-config.service

[Service]
Type=oneshot
ExecStart=$RP_SBIN/rp-hostname

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable rp-hostname.service >/dev/null 2>&1 || fail "could not enable rp-hostname.service"
  sudo env RP_HOSTNAME_ETC="$RP_ETC" "$RP_SBIN/rp-hostname" >/dev/null || fail "os-hostname: rp-hostname failed"
  result "$(printf '{"ok":true,"hostname":"%s"}' "$(hostname)")"
}

# github-auth <token file>: sign gh and git in with the user's GitHub token (Settings > Cloud sandboxes). The token
# reaches this step only as a 0600 file that boat's files API wrote (never on a command line); gh reads it on stdin and
# the file is removed whatever happens. --insecure-storage: the sandbox's keyring has no default collection and a store
# would hang, so gh keeps it in ~/.config/gh/hosts.yml, owner-only. No gh output reaches the result (it can echo token
# prefixes): `invalid` when GitHub refuses the token, `error` with a fixed reason otherwise.
step_github_auth() {
  local file="${1:-}" out rc=0 setup_rc=0 user
  [ -f "$file" ] || fail "github-auth: no token file"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "shred -u '$file' 2>/dev/null || rm -f '$file'" EXIT
  chmod 600 "$file"
  if ! command -v gh >/dev/null 2>&1; then
    result '{"ok":true,"state":"error","reason":"gh-missing"}'
    return
  fi
  out="$(gh auth login --hostname github.com --with-token --insecure-storage <"$file" 2>&1)" || rc=$?
  shred -u "$file" 2>/dev/null || rm -f "$file"
  # GitHub refused THIS token: invalid, even if an older token from an earlier start still signs gh in. A classic token
  # without a scope gh requires can't sign in either; gh skips that check for fine-grained tokens (no X-OAuth-Scopes
  # header; pkg/cmd/auth/shared/oauth_scopes.go HeaderHasMinimumScopes).
  if [ "$rc" -ne 0 ]; then
    case "$out" in *"HTTP 401"*|*"Bad credentials"*|*"missing required scope"*) result '{"ok":true,"state":"invalid"}'; return ;; esac
  fi
  [ -f "$HOME/.config/gh/hosts.yml" ] && chmod 600 "$HOME/.config/gh/hosts.yml"
  # setup-git can fail once while the sandbox settles after a resume; one more try.
  gh auth setup-git --hostname github.com >/dev/null 2>&1 || gh auth setup-git --hostname github.com >/dev/null 2>&1 || setup_rc=$?
  # Whether the sandbox IS signed in decides, not one step's exit code: gh can exit non-zero while staying signed in
  # (a token already stored, say), and the row must not warn about a sandbox that works.
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    user="$(gh api user --jq .login 2>/dev/null || true)"
    if ! [[ "$user" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; then
      user="$(gh auth status --hostname github.com 2>&1 | sed -n 's/.*Logged in to github\.com account \([A-Za-z0-9][A-Za-z0-9-]*\).*/\1/p' | head -1)"
    fi
    [[ "$user" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || user=""
    result "$(printf '{"ok":true,"state":"signed-in","user":"%s"}' "$user")"
    return
  fi
  if [ "$rc" -ne 0 ]; then result '{"ok":true,"state":"error","reason":"login-failed"}'
  elif [ "${setup_rc:-0}" -ne 0 ]; then result '{"ok":true,"state":"error","reason":"setup-git-failed"}'
  else result '{"ok":true,"state":"error","reason":"status-failed"}'; fi
}

# local-env-install <uploaded env file | "">: the variables the user's LOCAL start script printed (Settings > Cloud
# sandboxes > Local start script), for this sandbox only. The upload came through boat's files API (never a command
# line). Only `export NAME='value'` lines are kept (single quotes, ' as '\''), so sourcing never runs a value; reserved
# names (the sandbox's own runtime and sign-ins) are dropped. Values are never printed: the result has counts and the
# dropped reserved NAMES. No upload: the env file is removed, so no stale values stay. Then terminals (~/.bashrc),
# login shells (~/.profile) and every bash the daemon's agents run (BASH_ENV, a daemon drop-in) source the loader.
step_local_env_install() {
  local upload="${1:-}" dropin="$HOME/.config/systemd/user/pane-remote-daemon.service.d" filtered rc
  mkdir -p "$(dirname "$LOCAL_ENV")"
  if [ -n "$upload" ]; then
    [ -f "$upload" ] || fail "local-env-install: no uploaded env file"
    # shellcheck disable=SC2064 # the path is fixed now
    trap "shred -u '$upload' 2>/dev/null || rm -f '$upload'" EXIT
    filtered="$(python3 - "$upload" "$LOCAL_ENV" <<'PY'
import json, re, sys
line_re = re.compile(r"^export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'$")
reserved_exact = {"PATH", "HOME", "USER", "SHELL", "BASH_ENV", "ENV", "IFS", "GITHUB_TOKEN"}
reserved_prefix = ("LD_", "GIT_", "SSH_", "PANE_", "RUNPANE_", "CLAUDE_", "ANTHROPIC_", "GH_")
kept, dropped, reserved = [], 0, set()
for line in open(sys.argv[1], encoding="utf-8", errors="surrogateescape", newline="").read().split("\n"):
    if line == "":
        continue
    match = line_re.match(line)
    if not match:
        dropped += 1
        continue
    name = match.group(1)
    if name in reserved_exact or name.startswith(reserved_prefix):
        dropped += 1
        reserved.add(name)
        continue
    kept.append(line)
with open(sys.argv[2], "w", encoding="utf-8", errors="surrogateescape", newline="") as out:  # in place, never renamed
    out.write("".join(item + "\n" for item in kept))
result = {"ok": True, "keys": len(kept), "dropped": dropped}
if reserved:
    result["reserved"] = sorted(reserved)
print(json.dumps(result, separators=(",", ":")))
PY
)" || fail "local-env-install: could not write the env file"
    chmod 600 "$LOCAL_ENV"
  else
    rm -f "$LOCAL_ENV"
    filtered='{"ok":true,"keys":0,"dropped":0}'
  fi
  printf '%s\n' "# runpane-cloud: the local start script's variables (Settings > Cloud sandboxes > Local start script)." \
    'if [ -r "$HOME/.config/runpane-cloud/local-env" ]; then . "$HOME/.config/runpane-cloud/local-env"; fi' >"$LOCAL_ENV_LOADER"
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    grep -q "runpane-cloud local-env" "$rc" 2>/dev/null \
      || printf '\n%s\n' '[ -r "$HOME/.config/runpane-cloud/local-env.sh" ] && . "$HOME/.config/runpane-cloud/local-env.sh" # runpane-cloud local-env' >>"$rc"
  done
  mkdir -p "$dropin"
  printf '[Service]\nEnvironment=BASH_ENV=%%h/.config/runpane-cloud/local-env.sh\n' >"$dropin/local-env.conf"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rc=0
  result "$filtered"
  return "$rc"
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
  agent-env) step_agent_env "$@" ;;
  agent-prompts) step_agent_prompts ;;
  claude-model) step_claude_model "$@" ;;
  install-pane) step_install_pane "$@" ;;
  update-pane) step_update_pane "$@" ;;
  pairing-read) step_pairing_read ;;
  health-local) step_health_local ;;
  firewall) step_firewall "$@" ;;
  ts-guard) step_ts_guard ;;
  cert-status) step_cert_status "$@" ;;
  serve-http) step_serve_http ;;
  serve-guard) step_serve_guard "$@" ;;
  startup-install) step_startup_install "$@" ;;
  startup-run) step_startup_run "$@" ;;
  startup-status) step_startup_status ;;
  startup-log) step_startup_log ;;
  os-hostname) step_os_hostname "$@" ;;
  github-auth) step_github_auth "$@" ;;
  local-env-install) step_local_env_install "$@" ;;
  *) fail "unknown step '$step'" ;;
esac
