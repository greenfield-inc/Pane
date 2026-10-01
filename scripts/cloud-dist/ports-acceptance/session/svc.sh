#!/bin/bash
# Runs IN a Session (or any Linux box with systemd --user): tiny HTTP servers that say which box served
# the request, as user units so they come back after a wake without anyone starting them.
# usage: svc.sh <label> <port>...    (stop: svc.sh --stop <port>...)
# Body: "ports-acceptance label=<label> port=<p> tailnet=<MagicDNS name> boot=<boot id> t=<time>".
set -euo pipefail
if [ "${1:-}" = --stop ]; then
  shift
  for p in "$@"; do systemctl --user disable --now "pa-www-$p.service" 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/pa-www-$p.service"; done
  systemctl --user daemon-reload; exit 0
fi
L="$1"; shift
mkdir -p "$HOME/.local/share/ports-acceptance" "$HOME/.config/systemd/user"
cat > "$HOME/.local/share/ports-acceptance/www.py" <<'PY'
import http.server, json, subprocess, sys, time
label, port = sys.argv[1], int(sys.argv[2])
def dns():
    try: return json.loads(subprocess.run(['tailscale', 'status', '--self', '--json'], capture_output=True, timeout=5).stdout)['Self']['DNSName'].rstrip('.')
    except Exception: return '?'
DNS = ''
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global DNS
        DNS = DNS if DNS not in ('', '?') else dns()  # at boot this unit may start before tailscaled
        boot = open('/proc/sys/kernel/random/boot_id').read().strip()[:8]
        body = f'ports-acceptance label={label} port={port} tailnet={DNS} boot={boot} t={time.strftime("%H:%M:%SZ", time.gmtime())}\n'.encode()
        self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
PY
for p in "$@"; do
  cat > "$HOME/.config/systemd/user/pa-www-$p.service" <<UNIT
[Unit]
Description=ports-acceptance test server :$p ($L)
[Service]
ExecStart=/usr/bin/python3 %h/.local/share/ports-acceptance/www.py $L $p
Restart=always
[Install]
WantedBy=default.target
UNIT
done
systemctl --user daemon-reload
for p in "$@"; do systemctl --user enable "pa-www-$p.service" >/dev/null 2>&1; systemctl --user restart "pa-www-$p.service"; done
sleep 1
for p in "$@"; do printf '127.0.0.1:%s -> %s' "$p" "$(curl -sS --max-time 3 "http://127.0.0.1:$p/" || echo DOWN)"; done
echo "linger: $(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)"
