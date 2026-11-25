"""Contract commands that map straight onto a Pane daemon channel, and pane:// links."""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from typing import Any, Dict, Optional
from urllib.parse import quote_plus, urlencode

from .daemon_client import invoke_daemon
from .generated_contract import RUNPANE_CONTRACT
from .notify import RunpaneError

LINK_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
REPO_ID = re.compile(r"^[1-9][0-9]{0,15}$")
# A repository id, saved name, or owner/repo for a start link, as Pane's URL handler accepts it.
REPO_SELECTOR = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,2}\Z")
MAX_LINK_PROMPT_LENGTH = 4000
# The longest start link Pane opens, after URL encoding.
MAX_START_LINK_LENGTH = 16384


def repo_id(repo: Optional[str]) -> Optional[int]:
    """A numeric repository id, as app channels and repo links take it."""
    if repo is None:
        return None
    if not REPO_ID.match(repo):
        raise ValueError("--repo must be a numeric repository id. Run `runpane repos list` to find it.")
    return int(repo)


FLAG_VALUES = {
    "--pane": lambda parsed: parsed.pane_id,
    "--panel": lambda parsed: parsed.panel_id,
    "--message": lambda parsed: parsed.message,
    "--url": lambda parsed: parsed.url,
    "--name": lambda parsed: parsed.name,
    "--folder": lambda parsed: parsed.folder,
    "--repo": lambda parsed: repo_id(parsed.repo),
}


def contract_command(name: str) -> Dict[str, Any]:
    return next((command for command in RUNPANE_CONTRACT["commands"] if command["name"] == name), {})


def run_daemon_action(parsed: Any, action: Dict[str, Any]) -> int:
    args = []
    for flag in action["args"]:
        value = FLAG_VALUES[flag](parsed)
        if value is None:
            raise ValueError(f"runpane {parsed.command} requires {flag}.")
        args.append(value)
    spec = contract_command(parsed.command)
    if spec.get("mutates"):
        confirm_mutation(parsed)
    result = normalize_response(invoke_daemon(action["channel"], args, pane_dir=parsed.pane_dir))
    # A destructive change to a Pane comes back with a link the user can open to review it.
    if result["ok"] and parsed.pane_id and spec.get("mutates") and not spec.get("additive"):
        result["link"] = build_pane_link("pane", parsed.pane_id)
    if parsed.json:
        print(json.dumps(result, indent=2))
    elif result["ok"]:
        print("Done." if "data" not in result else json.dumps(result["data"], indent=2))
    else:
        print(result["error"]["message"], file=sys.stderr)
    return 0 if result["ok"] else 1


def confirm_mutation(parsed: Any) -> None:
    """Mutating commands need --yes outside an interactive terminal, like every runpane mutation."""
    if parsed.yes:
        return
    if parsed.json or not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise RunpaneError(
            "ERR_RUNPANE_CONFIRMATION_REQUIRED",
            f"runpane {parsed.command} mutates Pane state and needs confirmation, which --json or a non-interactive shell cannot give. Nothing was changed.",
            "Rerun with --yes.",
        )
    if input(f"Run {parsed.command}? [y/N] ").strip().lower() not in {"y", "yes"}:
        raise ValueError("Cancelled.")


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


def build_start_link(repo: str, prompt: str, agent: Optional[str] = None) -> str:
    """pane://new?repo=<repo>&prompt=<text>[&agent=<id>], encoded as the npm CLI's URLSearchParams does."""
    params = [("repo", repo), ("prompt", prompt)] + ([("agent", agent)] if agent else [])
    return "pane://new?" + "&".join(f"{key}={quote_plus(value, safe='*').replace('~', '%7E')}" for key, value in params)


def is_unsafe_character(character: str) -> bool:
    """Controls other than tab and newline, format characters, line and paragraph separators; Pane refuses them in a link's prompt."""
    return character not in "\t\n" and unicodedata.category(character) in ("Cc", "Cf", "Zl", "Zp")


def collapse_padding(text: str) -> str:
    """The prompt as Pane shows and sends it: trailing spaces and runs of blank lines removed."""
    return re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in text.split("\n"))).strip()


def start_link_target(parsed: Any, prompt: str) -> Dict[str, str]:
    if not parsed.repo or parsed.pane_id or parsed.panel_id or parsed.session_id:
        raise ValueError("A start link takes --repo and --prompt (and optionally --agent), not --pane, --panel or --session.")
    if not REPO_SELECTOR.match(parsed.repo):
        raise ValueError("--repo must be a repository id, saved name, or owner/repo. Run `runpane repos list` to find it.")
    if any(is_unsafe_character(character) for character in prompt):
        raise ValueError("--prompt must not contain control characters (other than tab and newline), or text-direction or invisible characters.")
    text = collapse_padding(prompt)
    if not text:
        raise ValueError("--prompt must not be empty.")
    if len(text) > MAX_LINK_PROMPT_LENGTH:
        raise ValueError(f"--prompt must be at most {MAX_LINK_PROMPT_LENGTH} characters for a link.")
    if text.startswith("-"):
        raise ValueError('--prompt must not start with "-", which an agent would read as an option.')
    target = {"kind": "new", "id": parsed.repo, "prompt": text}
    if parsed.agent:
        target["agent"] = parsed.agent
    return target


def run_links_create(parsed: Any) -> int:
    if parsed.initial_input is not None:
        target = start_link_target(parsed, parsed.initial_input)
        url = build_start_link(target["id"], target["prompt"], target.get("agent"))
        if len(url) > MAX_START_LINK_LENGTH:
            raise ValueError(f"--prompt makes a {len(url)}-character link once encoded; Pane opens links up to {MAX_START_LINK_LENGTH}. Shorten the prompt.")
        if parsed.json:
            print(json.dumps({"ok": True, "url": url, "target": target}, indent=2, ensure_ascii=False))
        else:
            print(url)
        return 0
    if parsed.agent:
        raise ValueError("--agent needs --prompt: it names the agent a start link starts.")
    given = [name for name, value in (("pane", parsed.pane_id), ("repo", parsed.repo), ("session", parsed.session_id)) if value]
    if len(given) != 1:
        raise ValueError("runpane links create needs exactly one of --pane, --repo, or --session.")
    if parsed.panel_id and not parsed.pane_id:
        raise ValueError("--panel needs --pane: a panel link opens the panel inside its Pane.")
    target: Dict[str, str]
    if parsed.repo:
        target = {"kind": "repo", "id": str(repo_id(parsed.repo))}
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
