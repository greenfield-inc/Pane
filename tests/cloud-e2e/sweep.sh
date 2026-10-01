#!/usr/bin/env bash
# Delete rp-loop-e2e-* sandboxes and tailnet devices that no running gate owns (after an aborted run).
# A resource is "owned" if it is listed in resources.txt of a run whose gate process is still alive.
HERE="$(cd "$(dirname "$0")" && pwd)"; cl() { python3 "$HERE/lib/cloudlab.py" "$@"; }
PREFIX="${E2E_PREFIX:-rp-loop-e2e}"; ROOT="${E2E_EVIDENCE_ROOT:-$HOME/rc-loop/evidence/e2e-gates}"
owned=$(pgrep -f "cloud-e2e.*/gates/|morning-smoke.sh" >/dev/null && find "$ROOT" -name resources.txt -mmin -90 -exec cat {} + 2>/dev/null | awk '{print $2}')
for dev in $(cl ts devices --prefix "$PREFIX" | python3 -c 'import json,sys;print(" ".join(d["nodeId"] for d in json.load(sys.stdin)))'); do
  grep -qx "$dev" <<<"$owned" || { echo "delete stray tailnet device $dev"; cl ts delete "$dev" >/dev/null; }
done
for sb in $(cl boat list --prefix "$PREFIX" | python3 -c 'import json,sys;print(" ".join(s["id"] for s in json.load(sys.stdin)))'); do
  grep -qx "$sb" <<<"$owned" || { echo "delete stray sandbox $sb"; cl boat delete "$sb" >/dev/null; }
done
echo "sweep done"
