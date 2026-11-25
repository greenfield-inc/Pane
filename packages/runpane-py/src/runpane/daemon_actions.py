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
# The start-link rules and builders below are copies of shared/startLinks.ts, which packages can't import.
MAX_LINK_PROMPT_LENGTH = 4000
# The longest start link Pane opens, after URL encoding.
MAX_START_LINK_LENGTH = 16384
# Chrome and Edge hand an app at most this many characters of a link from a web page.
MAX_WEB_LINK_LENGTH = 2048
# The page that opens a start link, or offers Pane's download when it isn't installed.
START_LINK_WEB_BASE = "https://runpane.com/open"
# A Session's id or name in a start link: printable, one line, at most 100 characters. Pane's URL handler applies the same rule.
MAX_SESSION_SELECTOR_LENGTH = 100

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


def start_link_query(target: Dict[str, str]) -> str:
    """The query both start-link forms share, in a readable order (agent, where, prompt), encoded as the npm CLI's URLSearchParams does."""
    params = [(key, target[key]) for key in ("agent", "repo", "session", "prompt") if target.get(key)]
    return "&".join(f"{key}={quote_plus(value, safe='*').replace('~', '%7E')}" for key, value in params)


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


# Unicode's Default_Ignorable_Code_Point ranges (Unicode 17), as Pane's \p{Default_Ignorable_Code_Point} matches them.
DEFAULT_IGNORABLE = (
    (0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)
EMOJI_VARIATION_SELECTORS = ("\uFE0E", "\uFE0F")


def is_unsafe_character(character: str) -> bool:
    """Controls other than tab and newline, format characters, line and paragraph separators; Pane refuses them in a link's prompt."""
    return character not in "\t\n" and unicodedata.category(character) in ("Cc", "Cf", "Zl", "Zp")


def has_unsafe_prompt_characters(text: str) -> bool:
    """is_unsafe_character, plus default-ignorable characters except one U+FE0E or U+FE0F right after a visible character."""
    previous = None
    for character in text:
        if is_unsafe_character(character):
            return True
        if character in EMOJI_VARIATION_SELECTORS:
            if previous is None or previous.isspace() or previous in EMOJI_VARIATION_SELECTORS:
                return True
        elif any(low <= ord(character) <= high for low, high in DEFAULT_IGNORABLE):
            return True
        previous = character
    return False


def is_unprintable_character(character: str) -> bool:
    """Any control, format, private-use or unassigned character, or a line or paragraph separator; Pane refuses them in a link's Session."""
    return unicodedata.category(character)[0] == "C" or unicodedata.category(character) in ("Zl", "Zp")


def collapse_padding(text: str) -> str:
    """The prompt as Pane shows and sends it: trailing spaces and runs of blank lines removed."""
    return re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in text.split("\n"))).strip()


def start_link_target(parsed: Any, prompt: str) -> Dict[str, str]:
    if parsed.pane_id or parsed.panel_id:
        raise ValueError("A start link takes --prompt with --agent, --repo or --session, not --pane or --panel.")
    if parsed.repo and parsed.session_id:
        raise ValueError("Give --repo or --session, not both: a start link runs in a new Pane in a repository, or in an existing Session.")
    if parsed.agent and parsed.session_id:
        raise ValueError("--agent does not apply with --session: the prompt goes to that Session's own agent.")
    if parsed.repo and not REPO_SELECTOR.match(parsed.repo):
        raise ValueError("--repo must be a repository id, saved name, or owner/repo. Run `runpane repos list` to find it.")
    session = None if parsed.session_id is None else parsed.session_id.strip()
    if parsed.session_id is not None and (any(is_unprintable_character(character) for character in parsed.session_id) or not session or len(session) > MAX_SESSION_SELECTOR_LENGTH):
        raise ValueError(f"--session must be a Session id or name of at most {MAX_SESSION_SELECTOR_LENGTH} characters on one line, with no control or invisible characters. Run `runpane sessions list` to find it.")
    if has_unsafe_prompt_characters(prompt):
        raise ValueError("--prompt must not contain control characters (other than tab and newline), or text-direction or invisible characters.")
    text = collapse_padding(prompt)
    if not text:
        raise ValueError("--prompt must not be empty.")
    if len(text) > MAX_LINK_PROMPT_LENGTH:
        raise ValueError(f"--prompt must be at most {MAX_LINK_PROMPT_LENGTH} characters for a link.")
    if text.startswith("-"):
        raise ValueError('--prompt must not start with "-", which an agent would read as an option.')
    # `id` is the repository selector, as v2.4.255 printed it; kept beside `repo` for callers that read it.
    target = {"kind": "new", "id": parsed.repo, "prompt": text} if parsed.repo else {"kind": "new", "prompt": text}
    if parsed.agent:
        target["agent"] = parsed.agent
    if parsed.repo:
        target["repo"] = parsed.repo
    if session:
        target["session"] = session
    return target


def print_start_link(parsed: Any, target: Dict[str, str]) -> int:
    query = start_link_query(target)
    url = f"pane://new?{query}"
    web_url = f"{START_LINK_WEB_BASE}?{query}"
    if len(url) > MAX_START_LINK_LENGTH:
        raise ValueError(f"--prompt makes a {len(url)}-character link once encoded; Pane opens links up to {MAX_START_LINK_LENGTH}. Shorten the prompt.")
    if parsed.web and len(web_url) > MAX_WEB_LINK_LENGTH:
        raise ValueError(f"--prompt makes a {len(web_url)}-character web link once encoded; Chrome and Edge open links up to {MAX_WEB_LINK_LENGTH} from a web page. Shorten the prompt.")
    if parsed.json:
        agent = target.get("agent")
        label = f"Open in Pane with {RUNPANE_CONTRACT['agents']['entries'][agent]['label']}" if agent else "Open in Pane"
        html = f'<a href="{escape_html(web_url)}">{escape_html(label)}</a>'
        print(json.dumps({"ok": True, "url": url, "webUrl": web_url, "html": html, "target": target}, indent=2, ensure_ascii=False))
    else:
        print(web_url if parsed.web else url)
    return 0


def run_links_create(parsed: Any) -> int:
    if parsed.initial_input is not None:
        return print_start_link(parsed, start_link_target(parsed, parsed.initial_input))
    if parsed.web:
        raise ValueError("--web needs --prompt: runpane.com/open opens start links only.")
    if parsed.agent:
        raise ValueError("--agent needs --prompt: it names the agent a start link starts.")
    given = [name for name, value in (("pane", parsed.pane_id), ("repo", parsed.repo), ("session", parsed.session_id)) if value]
    if len(given) != 1:
        raise ValueError("runpane links create needs exactly one of --pane, --repo, or --session, or a --prompt.")
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
