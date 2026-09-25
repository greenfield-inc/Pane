"""Contract commands that map straight onto a Pane daemon channel, and pane:// links."""
from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, Optional
from urllib.parse import urlencode

from .daemon_client import invoke_daemon
from .generated_contract import RUNPANE_CONTRACT

FLAG_VALUES = {
    "--pane": lambda parsed: parsed.pane_id,
    "--panel": lambda parsed: parsed.panel_id,
    "--message": lambda parsed: parsed.message,
    "--url": lambda parsed: parsed.url,
}
LINK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REPO_ID = re.compile(r"^[1-9][0-9]{0,15}$")


def contract_command(name: str) -> Dict[str, Any]:
    return next((command for command in RUNPANE_CONTRACT["commands"] if command["name"] == name), {})


def run_daemon_action(parsed: Any, action: Dict[str, Any]) -> int:
    args = []
    for flag in action["args"]:
        value = FLAG_VALUES[flag](parsed)
        if value is None:
            raise ValueError(f"runpane {parsed.command} requires {flag}.")
        args.append(value)
    if contract_command(parsed.command).get("mutates") and not parsed.yes:
        if parsed.json or not (sys.stdin.isatty() and sys.stdout.isatty()):
            raise ValueError(f"runpane {parsed.command} mutates Pane state. Rerun with --yes in non-interactive shells.")
        if input(f"Run {parsed.command}? [y/N] ").strip().lower() not in {"y", "yes"}:
            raise ValueError("Cancelled.")
    result = normalize_response(invoke_daemon(action["channel"], args, pane_dir=parsed.pane_dir))
    if parsed.json:
        print(json.dumps(result, indent=2))
    elif result["ok"]:
        print("Done." if "data" not in result else json.dumps(result["data"], indent=2))
    else:
        print(result["error"]["message"], file=sys.stderr)
    return 0 if result["ok"] else 1


def normalize_response(response: Any) -> Dict[str, Any]:
    if not isinstance(response, dict):
        return {"ok": True, "data": response}
    rest = {key: value for key, value in response.items() if key not in {"success", "error", "data"}}
    result: Dict[str, Any] = {"ok": response.get("success") is not False}
    payload = response["data"] if "data" in response else (rest or None)
    if payload is not None:
        result["data"] = payload
    if not result["ok"]:
        error = response.get("error")
        result["error"] = {"message": "Pane reported a failure." if error is None else str(error)}
    return result


def build_pane_link(kind: str, target_id: str, panel_id: Optional[str] = None) -> str:
    params = {kind: target_id}
    if panel_id:
        params["panel"] = panel_id
    return f"pane://open?{urlencode(params)}"


def run_links_create(parsed: Any) -> int:
    given = [name for name, value in (("pane", parsed.pane_id), ("repo", parsed.repo), ("session", parsed.session_id)) if value]
    if len(given) != 1:
        raise ValueError("runpane links create needs exactly one of --pane, --repo, or --session.")
    if parsed.panel_id and not parsed.pane_id:
        raise ValueError("--panel needs --pane: a panel link opens the panel inside its Pane.")
    target: Dict[str, str]
    if parsed.repo:
        if not REPO_ID.match(parsed.repo):
            raise ValueError("--repo must be a numeric repository id. Run `runpane repos list` to find it.")
        target = {"kind": "repo", "id": parsed.repo}
    else:
        kind = "pane" if parsed.pane_id else "session"
        target = {"kind": kind, "id": require_id(parsed.pane_id or parsed.session_id, f"--{kind}", f"runpane {kind}s list")}
        if parsed.panel_id:
            target["panelId"] = require_id(parsed.panel_id, "--panel", "runpane panels list")
    url = build_pane_link(target["kind"], target["id"], target.get("panelId"))
    if parsed.json:
        print(json.dumps({"ok": True, "url": url, "target": target}, indent=2))
    else:
        print(url)
    return 0


def require_id(value: Optional[str], flag: str, lister: str) -> str:
    if value is None or not LINK_ID.match(value):
        raise ValueError(f'{flag} must be an id (letters, digits, ".", "_", "-"). Run `{lister}` to find it.')
    return value
