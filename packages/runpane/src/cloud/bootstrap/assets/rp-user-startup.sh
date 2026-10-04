#!/bin/bash
# rp-user-startup: runs the user's startup script on a Pane cloud sandbox.
# Installed by rp-bootstrap.sh `startup-install` as /usr/local/sbin/rp-user-startup and run as the login user by
# rp-user-startup.service on every boot, and on demand (`startup-run`) after a create, a start or an edit.
#
#   script  ~/.config/runpane-cloud/startup.sh (no script: nothing runs and nothing is written)
#   log     ~/.local/state/runpane-cloud/startup.log, the latest run; startup.log.1 to .4 keep the 4 before it
#   status  ~/.local/state/runpane-cloud/startup-status.json:
#           {"exitCode","startedAt","finishedAt","sha256","envSha256","timedOut"}; exitCode and finishedAt are null while
#           it runs; envSha256 is the local env it ran with (null: none)
#   env     ~/.config/runpane-cloud/local-env: the local start script's variables (export lines), sourced first
#
# The script gets 10 minutes, then it is killed. The log holds the script's own output, so it is never printed here.
# Files are rewritten in place (cat >, never mv): a file renamed into place has come back empty after a boat restore.
set -uo pipefail
umask 077

SCRIPT="$HOME/.config/runpane-cloud/startup.sh"
LOCAL_ENV="$HOME/.config/runpane-cloud/local-env"
STATE="$HOME/.local/state/runpane-cloud"
LOG="$STATE/startup.log"
STATUS="$STATE/startup-status.json"
LIMIT="${RP_STARTUP_TIMEOUT_SECONDS:-600}"
KEEP=5

[ -s "$SCRIPT" ] || { echo "rp-user-startup: no startup script"; exit 0; }
mkdir -p "$STATE"
chmod 700 "$STATE"

now() { date -u +%FT%T.%3NZ; }
sha="$(sha256sum "$SCRIPT" | cut -d' ' -f1)"
env_sha=null
[ -f "$LOCAL_ENV" ] && env_sha="\"$(sha256sum "$LOCAL_ENV" | cut -d' ' -f1)\""
started="$(now)"
write_status() { # exitCode finishedAt timedOut
  printf '{"exitCode":%s,"startedAt":"%s","finishedAt":%s,"sha256":"%s","envSha256":%s,"timedOut":%s}\n' "$1" "$started" "$2" "$sha" "$env_sha" "$3" >"$STATUS"
}

# startup.log.4 is dropped; every older log moves up one.
for ((i = KEEP - 1; i > 1; i--)); do
  [ -f "$LOG.$((i - 1))" ] && cat "$LOG.$((i - 1))" >"$LOG.$i"
done
[ -f "$LOG" ] && cat "$LOG" >"$LOG.1"
echo "== startup script run at $started (sha256 $sha) ==" >"$LOG"
write_status null null false

SECONDS=0
# The local env's lines are `export NAME='value'`, so sourcing never runs a value.
timeout --kill-after=10 "$LIMIT" bash -c 'if [ -r "$1" ]; then . "$1"; fi; exec bash "$2"' rp-user-startup "$LOCAL_ENV" "$SCRIPT" >>"$LOG" 2>&1 </dev/null
code=$?
timed_out=false
# timeout exits 124 when it stopped the script, 137 when it had to kill it.
if { [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; } && [ "$SECONDS" -ge "$LIMIT" ]; then
  timed_out=true
  echo "== stopped after $LIMIT s (the time limit) ==" >>"$LOG"
fi
echo "== exit $code after $SECONDS s ==" >>"$LOG"
write_status "$code" "\"$(now)\"" "$timed_out"
if [ "$timed_out" = true ]; then echo "rp-user-startup: timed out"; else echo "rp-user-startup: exit $code"; fi
exit "$code"
