#!/usr/bin/env python3
"""A faithful-enough fake of GitHub for the Runpane Cloud broker gates (Python standard library only).

It models the part of GitHub the coordinator's GitHub broker talks to, and it enforces what GitHub
enforces, so a refusal seen in a gate is the broker's doing, never the fake's leniency:

  * git smart HTTP through the real `git http-backend` (bare repos under <state>/git/<owner>/<repo>.git);
  * GitHub App auth: RS256 app JWTs verified with the App's public key, installation tokens minted by
    POST /app/installations/:id/access_tokens and downscoped by `repositories` / `permissions` exactly as
    requested (a request beyond the installation's grant is a 422, like GitHub);
  * issue labels that don't exist are created (as GitHub does for a writer) and logged `labelsCreated`;
  * fine-grained PAT auth (a static token with a repo list and permissions), optional;
  * per-endpoint permission checks for installation tokens and PATs ("Resource not accessible by
    integration" 403), including GitHub's rule that a push touching .github/workflows/ needs the
    `workflows` permission;
  * REST for repos, branches, refs, compare, pulls, issues, comments, labels, commit statuses, check runs and
    Actions runs. Unmodelled paths are 404 and logged as `unmodelled`.

What it does NOT model (on purpose, like montlakev2 on the free plan): branch protection. A credential with
contents:write CAN move `master` here, so a gate that sees master unchanged proves the broker refused.

Every request is one JSON line in <state>/requests.jsonl: method, path, status, auth kind, a token id
(never the token), the permissions of the token used, and for pushes the ref updates. Bodies are not logged,
only the fields a gate needs (head, base, draft, state, number, title length, label names).

Admin endpoints (/_fake/..., header X-Fake-Admin: <state>/admin-token) read the log and state and seed
fixtures such as "another Session's PR". The server binds 127.0.0.1 by default.

Usage:
  fakegithub.py init  --state DIR --repo OWNER/NAME [--app-id N --app-public-key PEM --installation-id N]
                      [--pat-file FILE [--pat-classic]] [--app-slug S]
  fakegithub.py serve --state DIR [--host 127.0.0.1] [--port 0] [--port-file F]
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

GIT_ENV = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
LOCK = threading.RLock()

# --------------------------------------------------------------------------------------------- util

def now() -> int:
    return int(time.time())


def iso(t: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def token_id(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()[:12]


def git(repo: str, *args: str, input_bytes=None, env=None, check=True) -> str:
    e = dict(os.environ, **GIT_ENV, **(env or {}))
    p = subprocess.run(["git", "--git-dir", repo, *args], input=input_bytes, capture_output=True, env=e)
    if check and p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {p.stderr.decode(errors='replace').strip()}")
    return p.stdout.decode(errors="replace").strip()


# ------------------------------------------------------------------------------ RSA / JWT (RS256)

def _der_read(buf: bytes, i: int):
    tag = buf[i]; i += 1
    ln = buf[i]; i += 1
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(buf[i:i + n], "big"); i += n
    return tag, buf[i:i + ln], i + ln


def rsa_public_numbers(pem: str):
    """(n, e) from a PEM 'PUBLIC KEY' (SPKI) or 'RSA PUBLIC KEY' (PKCS#1)."""
    body = "".join(l for l in pem.strip().splitlines() if not l.startswith("-----"))
    der = base64.b64decode(body)
    tag, seq, _ = _der_read(der, 0)
    first_tag, _first, _ = _der_read(seq, 0)
    if first_tag == 0x30:  # SPKI: SEQ { SEQ algo, BIT STRING { RSAPublicKey } }
        _, _algo, j = _der_read(seq, 0)
        _, bits, _ = _der_read(seq, j)
        _, seq, _ = _der_read(bits[1:], 0)
    _, n, j = _der_read(seq, 0)
    _, e, _ = _der_read(seq, j)
    return int.from_bytes(n, "big"), int.from_bytes(e, "big")


SHA256_DIGESTINFO = bytes.fromhex("3031300d060960864801650304020105000420")


def rs256_verify(n: int, e: int, signing_input: bytes, sig: bytes) -> bool:
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    t = SHA256_DIGESTINFO + hashlib.sha256(signing_input).digest()
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return secrets.compare_digest(em, expected)


def verify_app_jwt(state: dict, jwt: str):
    """-> (ok, reason). GitHub's rules: RS256, iss = App id, exp in the future, exp - iat <= 10 min."""
    app = state.get("app")
    if not app:
        return False, "no app configured"
    parts = jwt.split(".")
    if len(parts) != 3:
        return False, "malformed jwt"
    try:
        header = json.loads(b64url_decode(parts[0]))
        payload = json.loads(b64url_decode(parts[1]))
        sig = b64url_decode(parts[2])
    except (ValueError, json.JSONDecodeError):
        return False, "undecodable jwt"
    if header.get("alg") != "RS256":
        return False, "alg must be RS256"
    if not rs256_verify(app["n"], app["e"], f"{parts[0]}.{parts[1]}".encode(), sig):
        return False, "bad signature"
    if str(payload.get("iss")) != str(app["id"]):
        return False, "iss is not the app id"
    iat, exp, t = payload.get("iat"), payload.get("exp"), now()
    if not isinstance(iat, int) or not isinstance(exp, int):
        return False, "iat/exp missing"
    if exp <= t or iat > t + 60 or exp - iat > 600:
        return False, "'Expiration time' claim ('exp') is too far in the future or expired"
    return True, ""


# ------------------------------------------------------------------------------------------ state

LEVEL = {"none": 0, "read": 1, "write": 2}


def load_state(d: str) -> dict:
    with open(os.path.join(d, "state.json")) as f:
        return json.load(f)


def save_state(d: str, st: dict) -> None:
    p = os.path.join(d, "state.json")
    with open(p + ".tmp", "w") as f:
        json.dump(st, f, indent=1)
    os.replace(p + ".tmp", p)


def repo_path(d: str, full: str) -> str:
    return os.path.join(d, "git", full + ".git")


def cmd_init(a) -> None:
    d = a.state
    os.makedirs(os.path.join(d, "git"), exist_ok=True)
    os.chmod(d, 0o700)
    owner, name = a.repo.split("/", 1)
    rp = repo_path(d, a.repo)
    if not os.path.isdir(rp):
        os.makedirs(os.path.dirname(rp), exist_ok=True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", a.default_branch, rp], check=True, env=dict(os.environ, **GIT_ENV))
        git(rp, "config", "http.receivepack", "true")
        git(rp, "config", "receive.denyDeletes", "false")
        with tempfile.TemporaryDirectory() as w:
            env = dict(os.environ, **GIT_ENV, GIT_AUTHOR_NAME="fake", GIT_AUTHOR_EMAIL="fake@example.invalid",
                       GIT_COMMITTER_NAME="fake", GIT_COMMITTER_EMAIL="fake@example.invalid")
            subprocess.run(["git", "init", "-q", "-b", a.default_branch, w], check=True, env=env)
            os.makedirs(os.path.join(w, ".github", "workflows"))
            with open(os.path.join(w, "README.md"), "w") as f:
                f.write(f"# {name}\n\nFake GitHub repo for the Runpane Cloud broker gate.\n")
            with open(os.path.join(w, ".github", "workflows", "ci.yml"), "w") as f:
                f.write("name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n")
            subprocess.run(["git", "-C", w, "add", "-A"], check=True, env=env)
            subprocess.run(["git", "-C", w, "commit", "-qm", "initial"], check=True, env=env)
            subprocess.run(["git", "-C", w, "push", "-q", rp, f"HEAD:refs/heads/{a.default_branch}"], check=True, env=env)
        hook = os.path.join(rp, "hooks", "pre-receive")
        with open(hook, "w") as f:
            f.write(f"#!/bin/sh\nexec {sys.executable} {os.path.abspath(__file__)} pre-receive\n")
        os.chmod(hook, 0o755)
    st = {"repos": {a.repo: {"id": 1000 + len(a.repo), "default_branch": a.default_branch, "private": True}},
          "labels": {a.repo: ["bug", "runpane-cloud"]},
          "issues": {a.repo: []}, "tokens": {}, "app": None, "pat": None}
    if os.path.exists(os.path.join(d, "state.json")):
        old = load_state(d)
        old["repos"].update(st["repos"]); old["labels"].setdefault(a.repo, st["labels"][a.repo]); old["issues"].setdefault(a.repo, [])
        st = old
    grant = {"contents": "write", "issues": "write", "pull_requests": "write", "metadata": "read"}
    for extra in a.grant or []:
        k, v = extra.split("=", 1)
        grant[k] = v
    if a.app_id:
        n, e = rsa_public_numbers(open(a.app_public_key).read())
        st["app"] = {"id": int(a.app_id), "slug": a.app_slug, "n": n, "e": e,
                     "installation": {"id": int(a.installation_id), "account": owner,
                                      "repos": sorted(set((st.get("app") or {}).get("installation", {}).get("repos", [])) | {a.repo}),
                                      "permissions": grant}}
    if a.pat_file:
        tok = open(a.pat_file).read().strip()
        st["pat"] = {"sha256": hashlib.sha256(tok.encode()).hexdigest(), "classic": bool(a.pat_classic),
                     "repos": [a.repo], "permissions": grant, "login": owner}
    admin = os.path.join(d, "admin-token")
    if not os.path.exists(admin):
        fd = os.open(admin, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, secrets.token_hex(24).encode()); os.close(fd)
    save_state(d, st)
    print(json.dumps({"repo": a.repo, "master": git(rp, "rev-parse", f"refs/heads/{a.default_branch}"),
                      "app": bool(st["app"]), "pat": bool(st["pat"])}))


# ---------------------------------------------------------------------------- pre-receive (git hook)

def cmd_pre_receive(_a) -> None:
    """Runs inside `git receive-pack` (as GitHub's own checks would). Env comes from the server."""
    log = os.environ.get("FAKEGH_REFLOG")
    workflows = os.environ.get("FAKEGH_WORKFLOWS", "none")
    zero = "0" * 40
    refused = []
    updates = []
    for line in sys.stdin:
        old, new, ref = line.split()
        updates.append({"ref": ref, "old": old, "new": new})
        if new == zero:
            continue
        rng = [new] if old == zero else [f"{old}..{new}"]
        if old == zero:  # a new branch: commits not already on any branch
            rng = [new, "--not", "--branches"]
        changed = subprocess.run(["git", "log", "--format=", "--name-only", *rng], capture_output=True, text=True).stdout.split()
        if LEVEL.get(workflows, 0) < 2 and any(p.startswith(".github/workflows/") for p in changed):
            refused.append(ref)
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"t": iso(now()), "kind": "receive", "updates": updates,
                                "refused": refused, "tokenId": os.environ.get("FAKEGH_TOKEN_ID")}) + "\n")
    for ref in refused:
        sys.stderr.write(f"refusing to allow a GitHub App to create or update workflow `.github/workflows/` without `workflows` permission ({ref})\n")
    sys.exit(1 if refused else 0)


# ------------------------------------------------------------------------------------------ server

class Denied(Exception):
    def __init__(self, status: int, message: str, errors: list | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.errors = errors


# endpoint -> required permission (resource, level). Order matters: first match wins.
REST_PERMS = [
    (r"^/repos/[^/]+/[^/]+$", "metadata", "read"),
    (r"^/repos/[^/]+/[^/]+/(branches|git/ref|git/refs|git/matching-refs|compare|commits(?!/[^/]+/(status|statuses|check-runs)))", "contents", None),
    (r"^/repos/[^/]+/[^/]+/commits/[^/]+/(status|statuses)$", "statuses", None),
    (r"^/repos/[^/]+/[^/]+/commits/[^/]+/check-runs$", "checks", None),
    (r"^/repos/[^/]+/[^/]+/actions/", "actions", None),
    (r"^/repos/[^/]+/[^/]+/pulls", "pull_requests", None),
    (r"^/repos/[^/]+/[^/]+/(issues|labels)", "issues", None),
]


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "fakegithub/1"
    protocol_version = "HTTP/1.1"

    # --- plumbing
    def log_message(self, fmt, *args):  # the JSONL log is the log
        pass

    def _body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _send(self, status: int, payload, headers=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        hs = {"Content-Type": "application/json; charset=utf-8", **(headers or {})}
        for k, v in hs.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.entry["status"] = status

    def _record(self):
        d = self.server.state_dir
        with LOCK, open(os.path.join(d, "requests.jsonl"), "a") as f:
            f.write(json.dumps(self.entry) + "\n")

    # --- auth
    def _auth(self, st: dict):
        """-> principal dict: {kind, tokenId?, repos?, permissions?}"""
        h = self.headers.get("Authorization", "")
        if not h:
            return {"kind": "none"}
        scheme, _, cred = h.partition(" ")
        cred = cred.strip()
        if scheme.lower() == "basic":
            try:
                cred = base64.b64decode(cred).decode().split(":", 1)[1]
            except (ValueError, IndexError):
                raise Denied(401, "Bad credentials")
        elif scheme.lower() not in ("bearer", "token"):
            raise Denied(401, "Bad credentials")
        if cred.count(".") == 2 and cred.startswith("ey"):
            ok, why = verify_app_jwt(st, cred)
            if not ok:
                raise Denied(401, f"A JSON web token could not be decoded ({why})")
            return {"kind": "app-jwt"}
        t = st["tokens"].get(token_id(cred))
        if t:
            if t["expires"] <= now():
                raise Denied(401, "Bad credentials")
            return {"kind": "installation", "tokenId": token_id(cred), "repos": t["repos"], "permissions": t["permissions"]}
        pat = st.get("pat")
        if pat and hashlib.sha256(cred.encode()).hexdigest() == pat["sha256"]:
            return {"kind": "pat", "tokenId": token_id(cred), "repos": pat["repos"], "permissions": pat["permissions"],
                    "classic": pat["classic"]}
        raise Denied(401, "Bad credentials")

    def _refs_readable(self, pr: dict):
        # Like GitHub: creating or updating a PR reads its head and base refs, which needs contents:read
        # (seen live on montlakev2 with a pull_requests:write-only installation token).
        if LEVEL.get(pr["permissions"].get("contents", "none"), 0) < LEVEL["read"]:
            raise Denied(422, "Validation Failed", [{"resource": "PullRequest", "code": "custom", "message": "not all refs are readable"}])

    def _need(self, pr: dict, repo: str, resource: str, level: str):
        if pr["kind"] in ("none", "app-jwt"):
            raise Denied(404 if pr["kind"] == "none" else 403, "Not Found" if pr["kind"] == "none" else
                         "A JSON web token cannot be used to access this resource")
        if repo not in pr["repos"]:
            raise Denied(404, "Not Found")  # GitHub hides repos a token can't see
        have = pr["permissions"].get(resource, "none")
        if resource == "metadata" and pr["permissions"]:
            have = "read"
        if LEVEL.get(have, 0) < LEVEL[level]:
            raise Denied(403, "Resource not accessible by integration" if pr["kind"] == "installation"
                         else "Resource not accessible by personal access token")

    # --- dispatch
    def do_GET(self): self._dispatch("GET")
    def do_POST(self): self._dispatch("POST")
    def do_PATCH(self): self._dispatch("PATCH")
    def do_PUT(self): self._dispatch("PUT")
    def do_DELETE(self): self._dispatch("DELETE")

    def _dispatch(self, method: str):
        u = urllib.parse.urlsplit(self.path)
        self.entry = {"t": iso(now()), "method": method, "path": u.path, "query": u.query, "remote": self.client_address[0]}
        try:
            body = self._body()
            with LOCK:
                st = load_state(self.server.state_dir)
            if u.path.startswith("/_fake/"):
                self._admin(method, u, body)
            elif re.match(r"^/[^/]+/[^/]+?(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$", u.path):
                self._git(method, u, body, st)
            else:
                self._rest(method, u, body, st)
        except Denied as d:
            self.entry["denied"] = d.message
            self._send(d.status, {"message": d.message, **({"errors": d.errors} if d.errors else {}), "documentation_url": "https://docs.github.com/rest"},
                       {"WWW-Authenticate": 'Basic realm="GitHub"'} if d.status == 401 else None)
        except Exception as ex:  # noqa: BLE001 - a fake must answer, and log what broke
            self.entry["error"] = str(ex)[:300]
            self._send(500, {"message": f"fakegithub error: {ex}"})
        finally:
            self._record()

    # --- admin
    def _admin(self, method, u, body):
        d = self.server.state_dir
        want = open(os.path.join(d, "admin-token")).read().strip()
        if not secrets.compare_digest(self.headers.get("X-Fake-Admin", ""), want):
            raise Denied(403, "admin token required")
        self.entry["auth"] = "admin"
        q = dict(urllib.parse.parse_qsl(u.query))
        if method == "GET" and u.path == "/_fake/log":
            with open(os.path.join(d, "requests.jsonl"), "rb") as f:
                return self._send(200, f.read(), {"Content-Type": "application/x-ndjson"})
        if method == "GET" and u.path == "/_fake/state":
            with LOCK:
                st = load_state(d)
            out = {"repos": {}}
            for full in st["repos"]:
                refs = git(repo_path(d, full), "for-each-ref", "--format=%(refname) %(objectname)").splitlines()
                out["repos"][full] = {"refs": dict(tuple(r.split(" ", 1)) for r in refs),
                                      "issues": [{k: i.get(k) for k in ("number", "pull", "state", "draft", "merged", "title", "user",
                                                                        "head", "base", "labels", "comments")}
                                                 | {"marker": re.findall(r"<!-- runpane-cloud:([^ ]+) -->", i.get("body") or "")}
                                                 for i in st["issues"][full]]}
            out["tokens"] = [{"id": k, **{x: v[x] for x in ("repos", "permissions", "expires", "issued")}} for k, v in st["tokens"].items()]
            return self._send(200, out)
        data = json.loads(body or b"{}")
        if method == "POST" and u.path == "/_fake/seed/pull":
            full = data["repo"]; rp = repo_path(d, full)
            base = data.get("base") or "master"
            base_sha = git(rp, "rev-parse", f"refs/heads/{base}")
            tree = git(rp, "rev-parse", f"{base_sha}^{{tree}}")
            env = {"GIT_AUTHOR_NAME": "other", "GIT_AUTHOR_EMAIL": "o@example.invalid",
                   "GIT_COMMITTER_NAME": "other", "GIT_COMMITTER_EMAIL": "o@example.invalid"}
            c = git(rp, "commit-tree", tree, "-p", base_sha, "-m", "seeded by the gate", env=env)
            git(rp, "update-ref", f"refs/heads/{data['head']}", c)
            with LOCK:
                st = load_state(d)
                it = self._new_issue(st, full, data.get("title", "seeded PR"), data.get("body", ""), "other-session[bot]")
                it.update(pull=True, draft=True, head={"ref": data["head"], "sha": c}, base={"ref": base, "sha": base_sha}, merged=False)
                save_state(d, st)
            return self._send(201, {"number": it["number"], "head": data["head"]})
        if method == "POST" and u.path == "/_fake/seed/check":
            with LOCK:
                st = load_state(d)
                run = {"id": now(), "name": data.get("name", "ci"), "head_sha": data["sha"], "status": data.get("status", "completed"),
                       "conclusion": data.get("conclusion", "success"), "started_at": iso(now()), "completed_at": iso(now()),
                       "html_url": f"https://github.com/{data['repo']}/runs/1"}
                st.setdefault("checks", {}).setdefault(data["repo"], []).append(run)
                save_state(d, st)
            return self._send(201, run)
        if method == "POST" and u.path == "/_fake/seed/issue":
            with LOCK:
                st = load_state(d)
                it = self._new_issue(st, data["repo"], data.get("title", "seeded issue"), data.get("body", ""), "other-session[bot]")
                save_state(d, st)
            return self._send(201, {"number": it["number"]})
        raise Denied(404, "Not Found")

    # --- git smart HTTP
    def _git(self, method, u, body, st):
        m = re.match(r"^/([^/]+)/([^/]+?)(?:\.git)?/(info/refs|git-upload-pack|git-receive-pack)$", u.path)
        full = f"{m.group(1)}/{m.group(2)}"
        q = dict(urllib.parse.parse_qsl(u.query))
        service = q.get("service") if m.group(3) == "info/refs" else m.group(3)
        self.entry.update(kind="git", repo=full, service=service)
        if full not in st["repos"]:
            raise Denied(404, "Repository not found.")
        pr = self._auth(st)
        self.entry.update(auth=pr["kind"], tokenId=pr.get("tokenId"), permissions=pr.get("permissions"))
        if pr["kind"] == "none":
            raise Denied(401, "Authentication required")
        if service == "git-receive-pack":
            self._need(pr, full, "contents", "write")
        elif service == "git-upload-pack":
            self._need(pr, full, "contents", "read")
        else:
            raise Denied(403, "Service not enabled")
        d = self.server.state_dir
        reflog = os.path.join(d, "receive.jsonl")
        before = sum(1 for _ in open(reflog)) if os.path.exists(reflog) else 0
        env = dict(os.environ, **GIT_ENV,
                   GIT_PROJECT_ROOT=os.path.join(d, "git"), GIT_HTTP_EXPORT_ALL="1",
                   PATH_INFO=f"/{full}.git/{m.group(3)}", QUERY_STRING=u.query, REQUEST_METHOD=method,
                   CONTENT_TYPE=self.headers.get("Content-Type", ""), CONTENT_LENGTH=str(len(body)),
                   REMOTE_USER="x-access-token", REMOTE_ADDR=self.client_address[0],
                   GIT_PROTOCOL=self.headers.get("Git-Protocol", ""),
                   FAKEGH_REFLOG=reflog, FAKEGH_TOKEN_ID=pr.get("tokenId") or "",
                   FAKEGH_WORKFLOWS=pr["permissions"].get("workflows", "none"))
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        p = subprocess.run(["git", "http-backend"], input=body, capture_output=True, env=env)
        head, _, out = p.stdout.partition(b"\r\n\r\n")
        if not _:
            head, _, out = p.stdout.partition(b"\n\n")
        status, hdrs = 200, {}
        for line in head.decode(errors="replace").splitlines():
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k:
                hdrs[k.strip()] = v.strip()
        if service == "git-receive-pack" and method == "POST" and os.path.exists(reflog):
            with open(reflog) as f:
                new = [json.loads(l) for l in f.readlines()[before:]]
            self.entry["receive"] = new
        hdrs.pop("Content-Length", None)
        self._send(status, out, hdrs)

    # --- REST
    def _new_issue(self, st, full, title, body, user):
        items = st["issues"].setdefault(full, [])
        it = {"number": len(items) + 1, "title": title, "body": body, "state": "open", "user": user, "pull": False,
              "labels": [], "comments": [], "created": iso(now())}
        items.append(it)
        return it

    def _issue_json(self, full, it):
        base = f"https://github.com/{full}"
        j = {"number": it["number"], "title": it["title"], "body": it["body"], "state": it["state"],
             "user": {"login": it["user"]}, "labels": [{"name": n} for n in it["labels"]], "comments": len(it["comments"]),
             "html_url": f"{base}/{'pull' if it['pull'] else 'issues'}/{it['number']}", "created_at": it["created"]}
        j.update(updated_at=it.get("updated", it["created"]), closed_at=it.get("closed"))
        if it["pull"]:
            j.update(draft=it["draft"], merged=it.get("merged", False), merged_at=it.get("merged_at"),
                     mergeable=None if it.get("merged") else True, head=it["head"], base=it["base"],
                     pull_request={"url": f"{base}/pull/{it['number']}"})
        return j

    def _rest(self, method, u, body, st):
        path = u.path.rstrip("/") or "/"
        q = dict(urllib.parse.parse_qsl(u.query))
        data = json.loads(body) if body.strip() else {}
        self.entry["kind"] = "rest"
        for k in ("head", "base", "draft", "state", "labels", "repositories", "permissions", "merge_method"):
            if isinstance(data, dict) and k in data:
                self.entry.setdefault("fields", {})[k] = data[k]
        if isinstance(data, dict) and "title" in data:
            self.entry.setdefault("fields", {})["titleLen"] = len(data["title"] or "")
        pr = self._auth(st)
        self.entry.update(auth=pr["kind"], tokenId=pr.get("tokenId"))
        d = self.server.state_dir
        app = st.get("app")

        # ---- App endpoints (JWT)
        if path == "/app" and method == "GET":
            if pr["kind"] != "app-jwt":
                raise Denied(401, "A JSON web token could not be decoded")
            return self._send(200, {"id": app["id"], "slug": app["slug"], "name": app["slug"],
                                    "permissions": app["installation"]["permissions"]})
        if path == "/app/installations" and method == "GET":
            if pr["kind"] != "app-jwt":
                raise Denied(401, "A JSON web token could not be decoded")
            ins = app["installation"]
            return self._send(200, [{"id": ins["id"], "account": {"login": ins["account"]}, "permissions": ins["permissions"],
                                     "repository_selection": "selected"}])
        m = re.match(r"^/repos/([^/]+)/([^/]+)/installation$", path)
        if m and method == "GET":
            if pr["kind"] != "app-jwt":
                raise Denied(401, "A JSON web token could not be decoded")
            if f"{m.group(1)}/{m.group(2)}" not in app["installation"]["repos"]:
                raise Denied(404, "Not Found")
            ins = app["installation"]
            return self._send(200, {"id": ins["id"], "account": {"login": ins["account"]}, "permissions": ins["permissions"]})
        m = re.match(r"^/app/installations/(\d+)/access_tokens$", path)
        if m and method == "POST":
            if pr["kind"] != "app-jwt":
                raise Denied(401, "A JSON web token could not be decoded")
            ins = app["installation"]
            if int(m.group(1)) != ins["id"]:
                raise Denied(404, "Not Found")
            owner = ins["account"]
            repos = [f"{owner}/{r}" for r in data.get("repositories") or []] or list(ins["repos"])
            if any(r not in ins["repos"] for r in repos):
                raise Denied(422, "There is at least one repository that does not exist or is not accessible to the parent installation.")
            perms = data.get("permissions") or dict(ins["permissions"])
            for k, v in perms.items():
                if LEVEL.get(v, 99) > LEVEL.get(ins["permissions"].get(k, "none"), 0):
                    raise Denied(422, "The permissions requested are not granted to this installation.")
            tok = "ghs_" + secrets.token_urlsafe(27).replace("-", "a").replace("_", "b")[:36]
            exp = now() + 3600
            with LOCK:
                st2 = load_state(d)
                st2["tokens"][token_id(tok)] = {"repos": repos, "permissions": perms, "expires": exp, "issued": iso(now())}
                save_state(d, st2)
            self.entry["minted"] = {"tokenId": token_id(tok), "repos": repos, "permissions": perms}
            return self._send(201, {"token": tok, "expires_at": iso(exp), "permissions": perms, "repository_selection": "selected",
                                    "repositories": [{"full_name": r, "name": r.split("/")[1]} for r in repos]})
        if path == "/installation/repositories" and method == "GET":
            if pr["kind"] != "installation":
                raise Denied(403, "This endpoint requires an installation token")
            return self._send(200, {"total_count": len(pr["repos"]),
                                    "repositories": [{"full_name": r, "name": r.split("/")[1], "default_branch": st["repos"][r]["default_branch"],
                                                      "private": True} for r in pr["repos"] if r in st["repos"]]})
        if path == "/user" and method == "GET":
            if pr["kind"] != "pat":
                raise Denied(403, "Resource not accessible by integration")
            hs = {"X-OAuth-Scopes": "repo, workflow"} if pr.get("classic") else {}
            return self._send(200, {"login": st["pat"]["login"], "type": "User"}, hs)
        if path == "/rate_limit":
            return self._send(200, {"resources": {"core": {"limit": 5000, "remaining": 4999, "reset": now() + 3600}}})
        if path == "/graphql":
            self.entry["unmodelled"] = True
            raise Denied(404, "Not Found")

        # ---- repo-scoped endpoints
        m = re.match(r"^/repos/([^/]+)/([^/]+)(/.*)?$", path)
        if not m:
            self.entry["unmodelled"] = True
            raise Denied(404, "Not Found")
        full, rest = f"{m.group(1)}/{m.group(2)}", m.group(3) or ""
        if full not in st["repos"]:
            raise Denied(404, "Not Found")
        for rx, res, lvl in REST_PERMS:
            if re.match(rx, path):
                self._need(pr, full, res, lvl or ("read" if method == "GET" else "write"))
                break
        else:
            self.entry["unmodelled"] = True
            raise Denied(404, "Not Found")
        rp = repo_path(d, full)
        repo = st["repos"][full]
        if rest == "" and method == "GET":
            return self._send(200, {"full_name": full, "name": m.group(2), "owner": {"login": m.group(1)}, "private": True,
                                    "default_branch": repo["default_branch"], "id": repo["id"],
                                    "html_url": f"https://github.com/{full}"})
        mb = re.match(r"^/(branches|git/ref/heads|git/refs/heads)/(.+)$", rest)
        if mb and method == "GET":
            sha = git(rp, "rev-parse", "--verify", "-q", f"refs/heads/{mb.group(2)}", check=False)
            if not sha:
                raise Denied(404, "Branch not found")
            if mb.group(1) == "branches":
                return self._send(200, {"name": mb.group(2), "commit": {"sha": sha}, "protected": False})
            return self._send(200, {"ref": f"refs/heads/{mb.group(2)}", "object": {"sha": sha, "type": "commit"}})
        mm = re.match(r"^/git/matching-refs/heads/(.*)$", rest)
        if mm and method == "GET":
            out = git(rp, "for-each-ref", "--format=%(refname) %(objectname)", f"refs/heads/{mm.group(1)}").splitlines()
            out = [l for l in out if l.split(" ")[0].startswith(f"refs/heads/{mm.group(1)}")]
            return self._send(200, [{"ref": l.split(" ")[0], "object": {"sha": l.split(" ")[1], "type": "commit"}} for l in out])
        md = re.match(r"^/git/refs/heads/(.+)$", rest)
        if md and method == "DELETE":
            if not git(rp, "rev-parse", "--verify", "-q", f"refs/heads/{md.group(1)}", check=False):
                raise Denied(422, "Reference does not exist")
            git(rp, "update-ref", "-d", f"refs/heads/{md.group(1)}")
            self.entry["deletedRef"] = md.group(1)
            return self._send(204, b"")
        mc = re.match(r"^/compare/(.+)\.\.\.(.+)$", rest)
        if mc and method == "GET":
            a_, b_ = (git(rp, "rev-parse", "--verify", "-q", x, check=False) for x in (mc.group(1), mc.group(2)))
            if not a_ or not b_:
                raise Denied(404, "Not Found")
            ahead = int(git(rp, "rev-list", "--count", f"{a_}..{b_}")); behind = int(git(rp, "rev-list", "--count", f"{b_}..{a_}"))
            files = git(rp, "diff", "--name-only", f"{a_}...{b_}").split()
            return self._send(200, {"ahead_by": ahead, "behind_by": behind, "status": "ahead" if behind == 0 else "diverged",
                                    "files": [{"filename": f} for f in files]})
        ms = re.match(r"^/commits/([^/]+)/(status|statuses|check-runs)$", rest)
        if ms and method == "GET":
            runs = [c for c in st.get("checks", {}).get(full, []) if c["head_sha"] in (ms.group(1),
                    git(rp, "rev-parse", "--verify", "-q", ms.group(1), check=False))]
            if ms.group(2) == "check-runs":
                return self._send(200, {"total_count": len(runs), "check_runs": runs})
            return self._send(200, {"state": "pending", "statuses": [], "total_count": 0} if ms.group(2) == "status" else [])
        if rest.startswith("/actions/runs") and method == "GET":
            return self._send(200, {"total_count": 0, "workflow_runs": []})
        if rest == "/labels" and method == "GET":
            return self._send(200, [{"name": n} for n in st["labels"].get(full, [])])
        ml = re.match(r"^/labels/(.+)$", rest)
        if ml and method == "GET":
            n = urllib.parse.unquote(ml.group(1))
            if n not in st["labels"].get(full, []):
                raise Denied(404, "Not Found")
            return self._send(200, {"name": n})

        # ---- issues and pulls (one number space, like GitHub)
        with LOCK:
            st = load_state(d)
            items = st["issues"].setdefault(full, [])

            def find(n, pull=None):
                it = next((i for i in items if i["number"] == int(n)), None)
                if it is None or (pull is True and not it["pull"]):
                    raise Denied(404, "Not Found")
                return it

            if rest == "/pulls" and method == "POST":
                self._refs_readable(pr)
                head = (data.get("head") or "").split(":")[-1]
                base = data.get("base") or repo["default_branch"]
                hs = git(rp, "rev-parse", "--verify", "-q", f"refs/heads/{head}", check=False)
                bs = git(rp, "rev-parse", "--verify", "-q", f"refs/heads/{base}", check=False)
                if not hs or not bs:
                    raise Denied(422, "Validation Failed: head or base does not exist")
                if any(i["pull"] and i["state"] == "open" and i["head"]["ref"] == head for i in items):
                    raise Denied(422, f"A pull request already exists for {full.split('/')[0]}:{head}.")
                it = self._new_issue(st, full, data.get("title", ""), data.get("body") or "", self._actor(pr, st))
                it.update(pull=True, draft=bool(data.get("draft", False)), merged=False,
                          head={"ref": head, "sha": hs}, base={"ref": base, "sha": bs})
                save_state(d, st)
                self.entry["number"] = it["number"]
                return self._send(201, self._issue_json(full, it))
            if rest == "/pulls" and method == "GET":
                sel = [i for i in items if i["pull"] and (q.get("state", "open") == "all" or i["state"] == q.get("state", "open"))
                       and (not q.get("head") or i["head"]["ref"] == q["head"].split(":")[-1])]
                return self._send(200, [self._issue_json(full, i) for i in sel])
            mp = re.match(r"^/pulls/(\d+)(/files|/reviews|/merge)?$", rest)
            if mp:
                it = find(mp.group(1), pull=True)
                self.entry["number"] = it["number"]
                sub = mp.group(2)
                if sub == "/merge":
                    self.entry["merge"] = True  # a gate asserts this never happens
                    if method == "PUT":
                        it.update(state="closed", merged=True, merged_at=iso(now()), closed=iso(now())); save_state(d, st)
                        return self._send(200, {"merged": True, "message": "Pull Request successfully merged"})
                    return self._send(204 if it.get("merged") else 404, b"")
                if sub == "/files" and method == "GET":
                    files = git(rp, "diff", "--name-status", f"{it['base']['sha']}...{it['head']['sha']}").splitlines()
                    return self._send(200, [{"filename": l.split("\t")[-1], "status": l.split("\t")[0]} for l in files])
                if sub == "/reviews":
                    if method == "POST":
                        self.entry["review"] = data.get("event")
                        return self._send(200, {"id": 1, "state": data.get("event", "COMMENTED")})
                    return self._send(200, [])
                if method == "GET":
                    return self._send(200, self._issue_json(full, it))
                if method == "PATCH":
                    self._refs_readable(pr)
                    for k in ("title", "body", "state"):
                        if k in data:
                            it[k] = data[k]
                    it["updated"] = iso(now()); it["closed"] = iso(now()) if it["state"] == "closed" else None
                    if "base" in data:
                        it["base"] = {"ref": data["base"], "sha": git(rp, "rev-parse", f"refs/heads/{data['base']}")}
                    save_state(d, st)
                    return self._send(200, self._issue_json(full, it))
            if rest == "/issues" and method == "POST":
                it = self._new_issue(st, full, data.get("title", ""), data.get("body") or "", self._actor(pr, st))
                known = st["labels"].setdefault(full, [])
                created = [n for n in data.get("labels") or [] if n not in known]
                if created:  # GitHub creates missing labels for a writer; the broker is meant to strip them first
                    known.extend(created)
                    self.entry["labelsCreated"] = created
                it["labels"] = list(data.get("labels") or [])
                save_state(d, st)
                self.entry["number"] = it["number"]
                return self._send(201, self._issue_json(full, it))
            if rest == "/issues" and method == "GET":
                sel = [i for i in items if q.get("state", "open") == "all" or i["state"] == q.get("state", "open")]
                return self._send(200, [self._issue_json(full, i) for i in sel])
            mi = re.match(r"^/issues/(\d+)(/comments)?$", rest)
            if mi:
                it = find(mi.group(1))
                self.entry["number"] = it["number"]
                if mi.group(2):
                    if method == "POST":
                        it["comments"].append({"id": len(it["comments"]) + 1, "body": data.get("body", ""), "user": self._actor(pr, st)})
                        save_state(d, st)
                        c = it["comments"][-1]
                        return self._send(201, {"id": c["id"], "body": c["body"], "user": {"login": c["user"]},
                                                "html_url": f"https://github.com/{full}/issues/{it['number']}#issuecomment-{c['id']}"})
                    return self._send(200, [{"id": c["id"], "body": c["body"], "user": {"login": c["user"]}} for c in it["comments"]])
                if method == "GET":
                    return self._send(200, self._issue_json(full, it))
                if method == "PATCH":
                    for k in ("title", "body", "state"):
                        if k in data:
                            it[k] = data[k]
                    if "labels" in data:
                        it["labels"] = [n for n in data["labels"] if n in st["labels"].get(full, [])]
                    save_state(d, st)
                    return self._send(200, self._issue_json(full, it))
        self.entry["unmodelled"] = True
        raise Denied(404, "Not Found")

    @staticmethod
    def _actor(pr, st):
        return f"{st['app']['slug']}[bot]" if pr["kind"] == "installation" else (st.get("pat") or {}).get("login", "user")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def cmd_serve(a) -> None:
    srv = Server((a.host, a.port), Handler)
    srv.state_dir = a.state
    port = srv.server_address[1]
    if a.port_file:
        with open(a.port_file, "w") as f:
            f.write(str(port))
    print(json.dumps({"listening": f"http://{a.host}:{port}", "state": a.state}), flush=True)
    srv.serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--state", required=True)
    i.add_argument("--repo", required=True)
    i.add_argument("--default-branch", default="master")
    i.add_argument("--app-id"); i.add_argument("--app-public-key"); i.add_argument("--installation-id", default="4242")
    i.add_argument("--app-slug", default="runpane-cloud-fake")
    i.add_argument("--pat-file"); i.add_argument("--pat-classic", action="store_true")
    i.add_argument("--grant", action="append", help="extra installation permission, e.g. workflows=write (to prove a refusal is the broker's)")
    s = sub.add_parser("serve")
    s.add_argument("--state", required=True); s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=0); s.add_argument("--port-file")
    sub.add_parser("pre-receive")
    a = ap.parse_args()
    {"init": cmd_init, "serve": cmd_serve, "pre-receive": cmd_pre_receive}[a.cmd](a)


if __name__ == "__main__":
    main()
