#!/bin/bash
# rp-hostname: give a Pane cloud sandbox's OS the sandbox's tailnet name (rp-…). A boat resume lands on a pool
# machine and brings back that machine's name (box-node-…), so this runs at every boot (rp-hostname.service) and
# after every create, start and update (rp-bootstrap.sh `os-hostname`), as root.
# The name is in /etc/rp-cloud/hostname. /etc/hostname and /etc/hosts are written in place (never renamed into place:
# a file renamed into place has come back empty after a boat restore). Tailscale is never touched: the tailnet device
# keeps the name it joined with (`tailscale up --hostname`).
set -euo pipefail
ETC="${RP_HOSTNAME_ETC:-/etc}"
want="$(cat "$ETC/rp-cloud/hostname" 2>/dev/null || true)"
if ! [[ "$want" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "rp-hostname: no valid name in $ETC/rp-cloud/hostname; nothing changed"
  exit 0
fi
# Resolvable first, so sudo never warns "unable to resolve host" about the new name.
grep -Eq "^127\.0\.1\.1[[:space:]]+([^#]*[[:space:]])?$want([[:space:]]|$)" "$ETC/hosts" 2>/dev/null || printf '127.0.1.1\t%s\n' "$want" >>"$ETC/hosts"
[ "$(cat "$ETC/hostname" 2>/dev/null || true)" = "$want" ] || printf '%s\n' "$want" >"$ETC/hostname"
[ "$(hostname)" = "$want" ] || hostname "$want"
echo "rp-hostname: $want"
