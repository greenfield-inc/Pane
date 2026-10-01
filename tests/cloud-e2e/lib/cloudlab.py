#!/usr/bin/env python3
"""cloudlab: stdlib-only oracle + results helper for the Runpane Cloud live gates.

The gates prove product behaviour through the documented surface (the `runpane` CLI,
`/health`, `/invoke`, `/cloud/wake`). This helper is the independent *oracle*: it asks the
provider (boat) and Tailscale APIs what really happened, reads pairing codes without ever
printing tokens, and records gate results.

Secrets are read from files only and never written to stdout, logs or evidence:
  CLOUDLAB_BOAT_AUTH_HEADER_FILE  file holding one line `Authorization: Bearer boat_...`
  CLOUDLAB_BOAT_API_KEY_FILE      alternative: file holding only the boat key
  CLOUDLAB_TS_CLIENT_ID / CLOUDLAB_TS_SECRET_FILE   Tailscale OAuth client (devices + auth_keys)
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import pathlib
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

BOAT_BASE = os.environ.get("CLOUDLAB_BOAT_BASE", "https://boat.dev/api/v1")
TS_BASE = "https://api.tailscale.com/api/v2"
HOME = pathlib.Path.home()
LOOP = HOME / "rc-loop"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def die(msg: str, code: int = 2) -> None:
    print(f"cloudlab: {msg}", file=sys.stderr)
    sys.exit(code)


def mutation(line: str) -> None:
    log = os.environ.get("CLOUDLAB_MUTATION_LOG", str(LOOP / "mutations.log"))
    if not pathlib.Path(log).parent.exists():
        return
    who = os.environ.get("PANE_SESSION_ID", "cloudlab")
    with open(log, "a") as fh:
        fh.write(f"{now_iso()} E2E {line} by {who}\n")


# ---------------------------------------------------------------- http


def http(method: str, url: str, headers: dict[str, str], body: Any = None,
         timeout: float = 60.0, raw: bool = False) -> tuple[int, Any, float]:
    data = None
    hdrs = dict(headers)
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as resp:
            payload = resp.read()
            status = resp.status
    except urllib.error.HTTPError as err:
        payload = err.read()
        status = err.code
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
        return 0, {"transportError": str(getattr(err, "reason", err))}, time.monotonic() - start
    elapsed = time.monotonic() - start
    if raw:
        return status, payload, elapsed
    try:
        return status, json.loads(payload or b"null"), elapsed
    except ValueError:
        return status, {"text": payload.decode(errors="replace")[:4000]}, elapsed


# ---------------------------------------------------------------- boat


def boat_headers() -> dict[str, str]:
    hdr_file = os.environ.get("CLOUDLAB_BOAT_AUTH_HEADER_FILE", str(LOOP / "secrets" / "boat.hdr"))
    key_file = os.environ.get("CLOUDLAB_BOAT_API_KEY_FILE")
    if key_file:
        return {"Authorization": "Bearer " + pathlib.Path(key_file).read_text().strip()}
    line = pathlib.Path(hdr_file).read_text().strip()
    name, _, value = line.partition(":")
    return {name.strip(): value.strip()}


def boat(method: str, path: str, body: Any = None, extra: Optional[dict[str, str]] = None,
         timeout: float = 90.0) -> tuple[int, Any]:
    headers = boat_headers()
    if os.environ.get("CLOUDLAB_BOAT_ORG"):  # bill/scope every call to this boat org (wallet) explicitly
        headers["X-Boat-Org"] = os.environ["CLOUDLAB_BOAT_ORG"]
    if extra:
        headers.update(extra)
    # boat caps sandbox starts (create/fork/resume) per account: 12/min, 60/h, 200/day. Wait instead of failing.
    deadline = time.monotonic() + float(os.environ.get("CLOUDLAB_RATE_WAIT_S", "1200"))
    while True:
        status, payload, _ = http(method, BOAT_BASE + path, headers, body, timeout=timeout)
        if method != "GET":
            mutation(f"BOAT {method} {path} -> {status}")
        limited = status == 429 and isinstance(payload, dict) and payload.get("code") == "rate_limited"
        if not limited or time.monotonic() > deadline:
            return status, payload
        print(f"cloudlab: boat rate limit on {method} {path}; retrying in 60 s", file=sys.stderr)
        time.sleep(60)


def sandbox_of(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        inner = payload.get("sandbox")
        return inner if isinstance(inner, dict) else payload
    return {}


def boat_get(sid: str) -> tuple[int, dict[str, Any]]:
    status, payload = boat("GET", f"/sandboxes/{sid}")
    return status, sandbox_of(payload)


def boat_list(prefix: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = None
    for _ in range(20):
        q = "?limit=100" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        status, payload = boat("GET", "/sandboxes" + q)
        if status != 200:
            die(f"boat list failed: HTTP {status}")
        out.extend(payload.get("sandboxes", []))
        cursor = payload.get("nextCursor") or payload.get("cursor")
        if not cursor:
            break
    return [s for s in out if str(s.get("name", "")).startswith(prefix)]


def boat_wait(sid: str, states: set[str], timeout: float) -> tuple[str, float]:
    start = time.monotonic()
    state = "?"
    while time.monotonic() - start < timeout:
        status, sb = boat_get(sid)
        if status == 404:
            state = "gone"
        else:
            state = str(sb.get("state", "?"))
        if state in states:
            return state, time.monotonic() - start
        if state in ("error", "cancelled") and state not in states:
            return state, time.monotonic() - start
        time.sleep(1.0)
    return state, time.monotonic() - start


def boat_exec(sid: str, script: str, timeout: int = 600) -> tuple[int, str, str]:
    """Upload a script with the files API and run it synchronously; returns (exit, out, err)."""
    name = f"rcl/e2e-{os.getpid()}-{int(time.time() * 1000)}.sh"
    content = base64.b64encode(script.encode()).decode()
    status, payload = boat("PUT", f"/sandboxes/{sid}/files",
                           {"path": name, "content": content, "encoding": "base64"})
    if status not in (200, 201, 204):
        return 255, "", f"file upload failed: HTTP {status} {json.dumps(payload)[:400]}"
    body = {"command": f"bash /home/user/{name}; rc=$?; rm -f /home/user/{name}; exit $rc",
            "timeoutSeconds": max(1, min(600, timeout))}
    for attempt in range(4):
        status, payload = boat("POST", f"/sandboxes/{sid}/commands", body, timeout=timeout + 30)
        if status == 409 and isinstance(payload, dict) and payload.get("retryable"):
            time.sleep(5)
            continue
        break
    if status != 200:
        return 255, "", f"exec failed: HTTP {status} {json.dumps(payload)[:600]}"
    result = payload.get("result", payload) if isinstance(payload, dict) else {}
    code = result.get("exitCode", result.get("exit_code", 255))
    return int(code if code is not None else 255), str(result.get("stdout", "")), str(result.get("stderr", ""))


def boat_put_file(sid: str, local: str, remote: str) -> int:
    """Copy a local (possibly secret) file into the sandbox. Content is never printed."""
    content = base64.b64encode(pathlib.Path(local).read_bytes()).decode()
    status, _ = boat("PUT", f"/sandboxes/{sid}/files", {"path": remote, "content": content, "encoding": "base64"})
    return status


# ---------------------------------------------------------------- tailscale


def ts_headers() -> dict[str, str]:
    client_id = os.environ.get("CLOUDLAB_TS_CLIENT_ID", "krreHuCr3M11CNTRL")
    secret_file = os.environ.get("CLOUDLAB_TS_SECRET_FILE", str(LOOP / "secrets" / "TAILSCALE_OAUTH_SECRET"))
    secret = pathlib.Path(secret_file).read_text().strip()
    form = urllib.parse.urlencode({"client_id": client_id, "client_secret": secret}).encode()
    status, payload, _ = http("POST", TS_BASE + "/oauth/token",
                              {"Content-Type": "application/x-www-form-urlencoded"}, form)
    if status != 200:
        die(f"tailscale oauth failed: HTTP {status}")
    return {"Authorization": "Bearer " + payload["access_token"]}


def ts_devices() -> list[dict[str, Any]]:
    status, payload, _ = http("GET", TS_BASE + "/tailnet/-/devices?fields=all", ts_headers())
    if status != 200:
        die(f"tailscale devices failed: HTTP {status}")
    return payload.get("devices", [])


def ts_find(hostname: str) -> list[dict[str, Any]]:
    """Devices whose MagicDNS short name or hostname equals `hostname` (or has a -N suffix)."""
    pat = re.compile(rf"^{re.escape(hostname)}(-\d+)?$")
    found = []
    for dev in ts_devices():
        short = str(dev.get("name", "")).split(".")[0]
        if pat.match(short) or dev.get("hostname") == hostname:
            found.append(dev)
    return found


def ts_delete(node_id: str) -> int:
    status, _, _ = http("DELETE", f"{TS_BASE}/device/{node_id}", ts_headers())
    mutation(f"TAILSCALE DELETE /device/{node_id} -> {status}")
    return status


def ts_mint(outfile: str) -> str:
    body = {"capabilities": {"devices": {"create": {"reusable": False, "ephemeral": False,
                                                     "preauthorized": True, "tags": ["tag:rp-session"]}}},
            "expirySeconds": 3600, "description": "rc-loop e2e single-use"}
    status, payload, _ = http("POST", TS_BASE + "/tailnet/-/keys", ts_headers(), body)
    if status != 200:
        die(f"tailscale key mint failed: HTTP {status}")
    fd = os.open(outfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(payload["key"])
    mutation("TAILSCALE mint single-use tag:rp-session key")
    return str(payload.get("id", "?"))


# ---------------------------------------------------------------- pairing / remote daemon


def read_pairing(path: str) -> dict[str, Any]:
    text = pathlib.Path(path).read_text()
    match = re.search(r"pane-remote://([A-Za-z0-9_\-=]+)", text)
    if not match:
        die(f"no pane-remote:// code in {path}")
    enc = match.group(1)
    enc += "=" * (-len(enc) % 4)
    return json.loads(base64.urlsafe_b64decode(enc.encode()))


def read_token_file(path: str) -> str:
    """A token file that is missing or empty must never fall back to the pairing token (it would turn a
    peer-scope check into a user-scope call)."""
    try:
        tok = pathlib.Path(path).read_text().strip()
    except OSError:
        die(f"token file {path} is missing")
    if not tok:
        die(f"token file {path} is empty")
    return tok


def resolve_base(target: str) -> tuple[str, Optional[str]]:
    """target is a pairing file, or a base URL. Returns (baseUrl, token-or-None)."""
    if os.path.isfile(target):
        pairing = read_pairing(target)
        return str(pairing["baseUrl"]).rstrip("/"), str(pairing["token"])
    return target.rstrip("/"), None


def bearer(token: Optional[str]) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def redact(value: Any, token: Optional[str]) -> Any:
    text = json.dumps(value)
    if token:
        text = text.replace(token, "<redacted>")
    text = re.sub(r"pane-remote://[A-Za-z0-9_\-=]+", "pane-remote://<redacted>", text)
    return json.loads(text)


def remote_invoke(target: str, channel: str, args: list[Any], use_token: bool = True,
                  token_override: Optional[str] = None, timeout: float = 60.0) -> tuple[int, Any, float]:
    base, token = resolve_base(target)
    headers: dict[str, str] = {}
    tok = token_override or (token if use_token else None)
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    status, payload, elapsed = http("POST", base + "/invoke", headers, {"channel": channel, "args": args},
                                    timeout=timeout)
    return status, redact(payload, tok), elapsed


# ---------------------------------------------------------------- results


def run_dir() -> pathlib.Path:
    rd = os.environ.get("E2E_RUN_DIR")
    if not rd:
        die("E2E_RUN_DIR is not set (source lib/common.sh)")
    return pathlib.Path(rd)


def record(gate: str, check: str, status: str, detail: str, evidence: str = "",
           metrics: Optional[dict[str, Any]] = None) -> None:
    status = status.upper()
    if status not in ("PASS", "FAIL", "SKIP", "BLOCKED", "INFO", "XFAIL"):
        die(f"bad status {status}")
    rec = {"ts": now_iso(), "run": os.environ.get("E2E_RUN_ID", "?"), "gate": gate, "check": check,
           "status": status, "detail": detail, "evidence": evidence,
           "target": os.environ.get("E2E_TARGET", ""), "metrics": metrics or {}}
    with open(run_dir() / "results.jsonl", "a") as fh:
        fh.write(json.dumps(rec) + "\n")
    mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭", "BLOCKED": "⛔", "INFO": "ℹ", "XFAIL": "✳"}[status]
    print(f"{mark} {status:7} {gate}/{check}: {detail}", flush=True)


def render_matrix(evidence_root: pathlib.Path, out: pathlib.Path) -> None:
    rows: list[dict[str, Any]] = []
    for results in sorted(evidence_root.glob("*/results.jsonl")):
        for line in results.read_text().splitlines():
            if line.strip():
                rec = json.loads(line)
                rec["_dir"] = str(results.parent)
                rows.append(rec)
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    history: dict[tuple[str, str], list[str]] = {}
    for rec in sorted(rows, key=lambda r: r["ts"]):
        key = (rec["gate"], rec["check"])
        latest[key] = rec
        history.setdefault(key, []).append(rec["status"][0])
    runs: dict[str, dict[str, Any]] = {}
    for rec in rows:
        run = runs.setdefault(rec["run"], {"dir": rec["_dir"], "first": rec["ts"], "target": rec.get("target", ""),
                                           "counts": {}})
        run["first"] = min(run["first"], rec["ts"])
        run["counts"][rec["status"]] = run["counts"].get(rec["status"], 0) + 1
    lines = [
        "# Runpane Cloud live gate matrix (e2e-gates)",
        "",
        f"_Generated {now_iso()} by `tests/cloud-e2e/lib/cloudlab.py matrix` from `{evidence_root}`._",
        "_Latest result per check; `hist` is the status sequence over all runs (P/F/S/B/X/I, oldest first)._",
        "_Status: PASS proven live; FAIL proven broken; XFAIL known-broken baseline (expected on this target);"
        " BLOCKED the feature/interface isn't available yet; SKIP not applicable to this run._",
        "",
        "| gate | check | status | when (UTC) | target | detail | evidence | hist |",
        "|---|---|---|---|---|---|---|---|",
    ]
    order = {"M0": 0, "M1": 1, "M2": 2, "M3": 3, "M4": 4, "SMOKE": 5}
    for key in sorted(latest, key=lambda k: (order.get(k[0].split("-")[0].split(".")[0], 9), k[0], k[1])):
        rec = latest[key]
        detail = str(rec["detail"]).replace("|", "\\|").replace("\n", " ")[:220]
        ev = rec.get("evidence") or rec["_dir"]
        lines.append(f"| {rec['gate']} | {rec['check']} | **{rec['status']}** | {rec['ts'][:19]} | "
                     f"{rec.get('target', '')} | {detail} | `{ev}` | {''.join(history[key][-12:])} |")
    lines += ["", "## Runs", "", "| run | started (UTC) | target | counts | evidence |", "|---|---|---|---|---|"]
    for run_id, run in sorted(runs.items(), key=lambda kv: kv[1]["first"], reverse=True):
        counts = " ".join(f"{k}:{v}" for k, v in sorted(run["counts"].items()))
        lines.append(f"| {run_id} | {run['first'][:19]} | {run['target']} | {counts} | `{run['dir']}` |")
    out.write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------- CLI


def main() -> None:
    p = argparse.ArgumentParser(prog="cloudlab")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("boat")
    bsub = b.add_subparsers(dest="op", required=True)
    x = bsub.add_parser("get"); x.add_argument("id"); x.add_argument("--field")
    x = bsub.add_parser("list"); x.add_argument("--prefix", default="")
    x = bsub.add_parser("create"); x.add_argument("name"); x.add_argument("type"); x.add_argument("--from", dest="src")
    x = bsub.add_parser("wait"); x.add_argument("id"); x.add_argument("states"); x.add_argument("--timeout", type=float, default=300)
    x = bsub.add_parser("stop"); x.add_argument("id")
    x = bsub.add_parser("resume"); x.add_argument("id")
    x = bsub.add_parser("delete"); x.add_argument("id")
    x = bsub.add_parser("exec"); x.add_argument("id"); x.add_argument("script"); x.add_argument("--timeout", type=int, default=600)
    x = bsub.add_parser("put"); x.add_argument("id"); x.add_argument("local"); x.add_argument("remote")
    x = bsub.add_parser("fetch"); x.add_argument("id"); x.add_argument("remote"); x.add_argument("local")

    t = sub.add_parser("ts")
    tsub = t.add_subparsers(dest="op", required=True)
    x = tsub.add_parser("find"); x.add_argument("hostname")
    x = tsub.add_parser("delete"); x.add_argument("node_id")
    x = tsub.add_parser("mint"); x.add_argument("outfile")
    x = tsub.add_parser("devices"); x.add_argument("--prefix", default="")

    r = sub.add_parser("remote")
    rsub = r.add_subparsers(dest="op", required=True)
    x = rsub.add_parser("base"); x.add_argument("target")
    x = rsub.add_parser("health"); x.add_argument("target"); x.add_argument("--timeout", type=float, default=10)
    x = rsub.add_parser("wait-health"); x.add_argument("target"); x.add_argument("--timeout", type=float, default=180)
    x.add_argument("--interval", type=float, default=0.5); x.add_argument("--require", default="")
    x = rsub.add_parser("invoke"); x.add_argument("target"); x.add_argument("channel"); x.add_argument("args", nargs="?", default="[]")
    x.add_argument("--no-token", action="store_true"); x.add_argument("--token-file"); x.add_argument("--timeout", type=float, default=60)
    x = rsub.add_parser("get"); x.add_argument("target"); x.add_argument("path"); x.add_argument("--no-token", action="store_true")
    x.add_argument("--token-file"); x.add_argument("--timeout", type=float, default=5)
    x = rsub.add_parser("ws"); x.add_argument("target"); x.add_argument("path"); x.add_argument("--token-file")
    x.add_argument("--no-token", action="store_true")
    x = rsub.add_parser("pairing-mode"); x.add_argument("file")
    x = rsub.add_parser("hold"); x.add_argument("target"); x.add_argument("path"); x.add_argument("--seconds", type=float, default=20)
    x.add_argument("--token-file"); x.add_argument("--no-token", action="store_true")

    x = sub.add_parser("record"); x.add_argument("gate"); x.add_argument("check"); x.add_argument("status")
    x.add_argument("detail"); x.add_argument("--evidence", default=""); x.add_argument("--metric", action="append", default=[])
    x = sub.add_parser("matrix"); x.add_argument("--evidence-root", default=str(LOOP / "evidence" / "e2e-gates"))
    x.add_argument("--out", default=str(LOOP / "results" / "e2e-matrix.md"))
    x = sub.add_parser("json"); x.add_argument("expr"); x.add_argument("file", nargs="?", default="-")

    a = p.parse_args()
    if a.cmd == "boat":
        if a.op == "get":
            status, sb = boat_get(a.id)
            if a.field:
                print("gone" if status == 404 else sb.get(a.field, ""))
            else:
                print(json.dumps({"http": status, **sb}))
        elif a.op == "list":
            print(json.dumps([{k: s.get(k) for k in ("id", "name", "state", "type", "createdAt")} for s in boat_list(a.prefix)]))
        elif a.op == "create":
            body: dict[str, Any] = {"type": a.type, "ttlSeconds": None, "noEnv": True}
            if a.src:
                body["from"] = a.src
            status, payload = boat("POST", "/sandboxes", body, {"Idempotency-Key": f"e2e-{a.name}-{time.time_ns()}"})
            sid = sandbox_of(payload).get("id")
            if status not in (200, 201, 202) or not sid:
                die(f"create failed: HTTP {status} {json.dumps(payload)[:400]}")
            boat("PATCH", f"/sandboxes/{sid}", {"name": a.name})
            reg = LOOP / "sandboxes.txt"
            if reg.exists():
                with open(reg, "a") as fh:
                    fh.write(f"{sid} {a.name} e2e-gates@{os.environ.get('PANE_SESSION_ID', 'cli')}\n")
            print(sid)
        elif a.op == "wait":
            state, secs = boat_wait(a.id, set(a.states.split(",")), a.timeout)
            print(json.dumps({"state": state, "seconds": round(secs, 2)}))
            sys.exit(0 if state in a.states.split(",") else 1)
        elif a.op in ("stop", "resume"):
            body = {} if a.op == "stop" else {"ttlSeconds": None}
            start = time.monotonic()
            status, payload = boat("POST", f"/sandboxes/{a.id}/{a.op}", body)
            print(json.dumps({"http": status, "seconds": round(time.monotonic() - start, 2),
                              "state": sandbox_of(payload).get("state")}))
            sys.exit(0 if status in (200, 202) else 1)
        elif a.op == "delete":
            status, payload = boat("DELETE", f"/sandboxes/{a.id}", extra={"X-Ascii-Confirm-Delete": a.id})
            print(json.dumps({"http": status}))
            destroyed = LOOP / "destroyed.txt"
            if destroyed.parent.exists():
                with open(destroyed, "a") as fh:
                    fh.write(f"{now_iso()} DESTROYED {a.id} (e2e-gates) http={status}\n")
            sys.exit(0 if status in (200, 202, 404) else 1)
        elif a.op == "exec":
            script = sys.stdin.read() if a.script == "-" else pathlib.Path(a.script).read_text()
            code, out, err = boat_exec(a.id, script, a.timeout)
            sys.stdout.write(out)
            sys.stderr.write(err)
            sys.exit(code)
        elif a.op == "put":
            status = boat_put_file(a.id, a.local, a.remote)
            sys.exit(0 if status in (200, 201, 204) else 1)
        elif a.op == "fetch":
            # Secret-safe: content goes straight into a 0600 file, never to stdout.
            code, out, err = boat_exec(a.id, f"base64 -w0 {a.remote}\n", 60)
            if code != 0:
                die(f"fetch {a.remote} failed: exit {code} {err[:300]}")
            fd = os.open(a.local, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as fh:
                fh.write(base64.b64decode(out.strip()))
    elif a.cmd == "ts":
        if a.op == "find":
            print(json.dumps([{k: d.get(k) for k in ("nodeId", "id", "name", "hostname", "tags", "addresses", "lastSeen")}
                              for d in ts_find(a.hostname)]))
        elif a.op == "delete":
            status = ts_delete(a.node_id)
            print(json.dumps({"http": status}))
            sys.exit(0 if status in (200, 404) else 1)
        elif a.op == "mint":
            print("minted key id", ts_mint(a.outfile))
        elif a.op == "devices":
            print(json.dumps([{k: d.get(k) for k in ("nodeId", "name", "tags", "lastSeen")} for d in ts_devices()
                              if str(d.get("name", "")).startswith(a.prefix)]))
    elif a.cmd == "remote":
        if a.op == "base":
            print(resolve_base(a.target)[0])
        elif a.op == "health":
            base, token = resolve_base(a.target)
            # The daemon reports version and readiness only to a paired client.
            status, payload, secs = http("GET", base + "/health", bearer(token), timeout=a.timeout)
            print(json.dumps({"http": status, "seconds": round(secs, 3), "body": payload}))
            sys.exit(0 if status == 200 else 1)
        elif a.op == "wait-health":
            base, token = resolve_base(a.target)
            start = time.monotonic()
            last: Any = None
            status = 0
            while time.monotonic() - start < a.timeout:
                status, last, _ = http("GET", base + "/health", bearer(token), timeout=3)
                ok = status == 200
                if ok and a.require:
                    ok = all(bool(eval(cond, {}, {"h": last})) for cond in a.require.split(";;"))  # noqa: S307 (gate-authored)
                if ok:
                    break
                time.sleep(a.interval)
            secs = time.monotonic() - start
            print(json.dumps({"http": status, "seconds": round(secs, 2), "body": last}))
            sys.exit(0 if status == 200 and secs < a.timeout else 1)
        elif a.op == "invoke":
            override = read_token_file(a.token_file) if a.token_file else None
            status, payload, secs = remote_invoke(a.target, a.channel, json.loads(a.args), not a.no_token,
                                                  override, a.timeout)
            print(json.dumps({"http": status, "seconds": round(secs, 3), "body": payload}))
            sys.exit(0 if status == 200 and isinstance(payload, dict) and payload.get("ok") else 1)
        elif a.op == "get":
            base, token = resolve_base(a.target)
            tok = read_token_file(a.token_file) if a.token_file else (None if a.no_token else token)
            headers = {"Authorization": f"Bearer {tok}"} if tok else {}
            status, payload, secs = http("GET", base + a.path, headers, timeout=a.timeout, raw=True)
            text = payload.decode(errors="replace")[:600] if isinstance(payload, bytes) else json.dumps(payload)
            if tok:
                text = text.replace(tok, "<redacted>")
            print(json.dumps({"http": status, "seconds": round(secs, 3), "head": text}))
        elif a.op == "ws":
            print(json.dumps(ws_probe(a)))
        elif a.op == "hold":
            print(json.dumps(hold_stream(a)))
        elif a.op == "pairing-mode":
            mode = oct(os.stat(a.file).st_mode & 0o777)
            pairing = read_pairing(a.file)
            print(json.dumps({"mode": mode, "label": pairing.get("label"), "baseUrl": pairing.get("baseUrl"),
                              "transport": pairing.get("transport"), "hasToken": bool(pairing.get("token"))}))
    elif a.cmd == "record":
        metrics = {}
        for m in a.metric:
            k, _, v = m.partition("=")
            try:
                metrics[k] = float(v)
            except ValueError:
                metrics[k] = v
        record(a.gate, a.check, a.status, a.detail, a.evidence, metrics)
    elif a.cmd == "matrix":
        render_matrix(pathlib.Path(a.evidence_root), pathlib.Path(a.out))
        print(a.out)
    elif a.cmd == "json":
        data = json.load(sys.stdin if a.file == "-" else open(a.file))
        val = eval(a.expr, {}, {"d": data})  # noqa: S307 (gate-authored expressions)
        print(val if isinstance(val, str) else json.dumps(val))


def ws_probe(a: argparse.Namespace) -> dict[str, Any]:
    """Minimal WebSocket upgrade probe: returns the HTTP status of the upgrade response."""
    import http.client
    base, token = resolve_base(a.target)
    tok = read_token_file(a.token_file) if a.token_file else (None if a.no_token else token)
    url = urllib.parse.urlparse(base + a.path)
    conn_cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(url.hostname, url.port, timeout=10)
    headers = {"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
               "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode()}
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    path = url.path + (f"?{url.query}" if url.query else "")
    try:
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        return {"http": resp.status}
    except OSError as err:
        return {"http": 0, "error": str(err)}
    finally:
        conn.close()


def hold_stream(a: argparse.Namespace) -> dict[str, Any]:
    """Open a streaming GET (e.g. /events) and keep reading for N seconds. Returns status + bytes read."""
    base, token = resolve_base(a.target)
    tok = read_token_file(a.token_file) if a.token_file else (None if a.no_token else token)
    headers = {"Accept": "text/event-stream"}
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(base + a.path, headers=headers)
    start = time.monotonic()
    got = 0
    try:
        with urllib.request.urlopen(req, timeout=a.seconds + 5, context=ssl.create_default_context()) as resp:
            status = resp.status
            while time.monotonic() - start < a.seconds:
                try:
                    chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(1)
                except (TimeoutError, OSError):
                    break
                if not chunk:
                    break
                got += len(chunk)
    except urllib.error.HTTPError as err:
        return {"http": err.code, "body": err.read().decode(errors="replace")[:300], "seconds": round(time.monotonic() - start, 2)}
    except (urllib.error.URLError, OSError) as err:
        return {"http": 0, "error": str(err), "seconds": round(time.monotonic() - start, 2)}
    return {"http": status, "bytes": got, "seconds": round(time.monotonic() - start, 2)}


if __name__ == "__main__":
    main()
