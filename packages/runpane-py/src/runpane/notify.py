"""`runpane notify`: ask the person a question wherever they are and print their answer."""

from __future__ import annotations

import json
import math
import os
import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .daemon_client import PaneDaemonClientError, invoke_daemon

UIS = ["options", "approve", "ask", "info"]
MAX_CHOICES = 9
MAX_DETAIL_LABEL = 40
MAX_LINKS = 6
MAX_LINK_LABEL = 80
LINK_URL = re.compile(r"https?://\S+")
# Each optional field and the one ui it belongs to.
FIELD_UI = [("choices", "options"), ("detail", "approve"), ("detailLabel", "approve"), ("suggestions", "ask"), ("action", "info")]
CHOICES_EXPECTED = 'choices must be a JSON array of choices, such as [{"label":"Ship it","recommended":true},{"label":"Wait"}].'
SUGGESTIONS_EXPECTED = 'suggestions must be a JSON array of strings, such as ["main","release"].'
ACTION_EXPECTED = 'action must be a JSON object with a non-empty "label" and "url", such as {"label":"Open PR","url":"https://github.com/org/repo/pull/1"}.'
LINKS_EXPECTED = 'links must be a JSON array of links, such as [{"label":"Notes","path":"docs/RELEASE.md"},{"label":"PR #1","url":"https://github.com/org/repo/pull/1"}].'
UNAVAILABLE_NEXT = "Ask in the terminal instead."
_MISSING = object()


class RunpaneError(RuntimeError):
    """What happened and why in the message; the step to take in `next`."""

    def __init__(self, code: str, message: str, next: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code
        self.next = next


def invalid(field: str, problem: str, next: Optional[str] = None) -> RunpaneError:
    return RunpaneError("ERR_NOTIFY_INVALID", f"{problem} Nothing was shown to the person.", next or f"Fix {field} and call notify again.")


def build_notify_request(parsed: Any, env: Mapping[str, str], cwd: str) -> Dict[str, Any]:
    """Checks the question and builds the `runpane:notify` request, like the npm CLI."""
    given = {
        "ui": parsed.notify_ui,
        "title": parsed.title,
        "context": parsed.notify_context,
        "choices": parsed.notify_choices,
        "detail": parsed.notify_detail,
        "detailLabel": parsed.notify_detail_label,
        "suggestions": parsed.notify_suggestions,
        "action": parsed.notify_action,
        "links": parsed.notify_links,
    }
    caller, timing = notify_caller_fields(env, cwd)

    if parsed.resume is not None:
        if not parsed.resume.strip():
            raise invalid("resume", "resume must be the id from a waiting result.")
        extra = [field for field, value in {**given, "relays": parsed.notify_relays, "aboutSession": parsed.notify_about_session}.items() if value is not None]
        if extra:
            raise invalid("resume", f"resume keeps waiting on an earlier question, so it takes no other fields; remove {', '.join(extra)}.", "Call notify again with only resume.")
        return {"resume": parsed.resume, **timing, "caller": caller}

    request: Dict[str, Any] = {**parse_notify_question(given), **timing, "caller": caller}
    if parsed.notify_relays is not None:
        if not parsed.notify_relays.strip():
            raise invalid("relays", "relays must be the id of a waiting item from runpane inbox.")
        request["relays"] = parsed.notify_relays
    if parsed.notify_about_session is not None:
        if not parsed.notify_about_session.strip():
            raise invalid("aboutSession", "aboutSession must be a Session id or name.")
        request["aboutSession"] = parsed.notify_about_session
    return request


def parse_notify_question(given: Mapping[str, Optional[str]]) -> Dict[str, Any]:
    """Checks a question's fields, for notify and for Autopilot's rewrite of an item. Fields left out read as not given."""
    given = {field: given.get(field) for field in ("ui", "title", "context", "choices", "detail", "detailLabel", "suggestions", "action", "links")}
    ui = given["ui"]
    if ui is None:
        raise invalid("ui", "ui is required: options, approve, ask, or info.")
    if ui not in UIS:
        raise invalid("ui", f'ui must be options, approve, ask, or info; got "{ui}".')
    if not (given["title"] or "").strip():
        raise invalid("title", "title is required: one line saying what you need.")
    for field, owner in FIELD_UI:
        if given[field] is not None and ui != owner:
            raise invalid(field, f"{field} is only for ui {owner}; this call is ui {ui}.")
    if ui == "options" and given["choices"] is None:
        raise invalid("choices", 'choices is required with ui options: 1 to 9 choices, such as [{"label":"Ship it"},{"label":"Wait"}].')
    if given["detailLabel"] is not None:
        if given["detail"] is None:
            raise invalid("detailLabel", "detailLabel names the disclosure that reveals detail, so it needs detail too.")
        if len(given["detailLabel"]) > MAX_DETAIL_LABEL:
            raise invalid("detailLabel", f"detailLabel takes up to {MAX_DETAIL_LABEL} characters; got {len(given['detailLabel'])}.")

    question: Dict[str, Any] = {"ui": ui, "title": given["title"]}
    if given["context"] is not None:
        question["context"] = given["context"]
    if given["choices"] is not None:
        question["choices"] = parse_choices(given["choices"])
    if given["detail"] is not None:
        question["detail"] = given["detail"]
    if given["detailLabel"] is not None:
        question["detailLabel"] = given["detailLabel"]
    if given["suggestions"] is not None:
        question["suggestions"] = parse_suggestions(given["suggestions"])
    if given["action"] is not None:
        question["action"] = parse_action(given["action"])
    if given["links"] is not None:
        question["links"] = parse_links(given["links"])
    return question


def notify_caller_fields(env: Mapping[str, str], cwd: str) -> Tuple[Dict[str, str], Dict[str, int]]:
    """Who is asking, from the Pane terminal's environment, and how soon to return waiting; shared with `secrets request`."""
    caller = {"cwd": cwd}
    for key, name in (("paneId", "PANE_SESSION_ID"), ("panelId", "PANE_PANEL_ID"), ("agent", "RUNPANE_NOTIFY_AGENT")):
        value = (env.get(name) or "").strip()
        if value:
            caller[key] = value
    return_after = (env.get("RUNPANE_NOTIFY_RETURN_AFTER_MS") or "").strip()
    timing = {"returnAfterMs": int(return_after)} if re.fullmatch(r"\d+", return_after) and int(return_after) > 0 else {}
    return caller, timing


def parse_choices(text: str) -> List[Dict[str, Any]]:
    value = parse_json(text)
    if not isinstance(value, list):
        raise invalid("choices", CHOICES_EXPECTED)
    if len(value) < 1 or len(value) > MAX_CHOICES:
        raise invalid("choices", f"choices takes 1 to {MAX_CHOICES} choices; got {len(value)}.")
    choices: List[Dict[str, Any]] = []
    labels = set()
    for index, item in enumerate(value):
        detail = item.get("detail", _MISSING) if isinstance(item, dict) else _MISSING
        recommended = item.get("recommended", _MISSING) if isinstance(item, dict) else _MISSING
        if (
            not isinstance(item, dict)
            or not is_text(item.get("label"))
            or (detail is not _MISSING and not isinstance(detail, str))
            or (recommended is not _MISSING and not isinstance(recommended, bool))
        ):
            raise invalid("choices", f'choices[{index}] must be an object with a non-empty "label", and optionally "detail" (text) and "recommended" (true or false).')
        label = item["label"]
        if label in labels:
            raise invalid("choices", f'choices[{index}] repeats the label "{label}"; each choice needs its own label.')
        labels.add(label)
        choice: Dict[str, Any] = {"label": label}
        if detail is not _MISSING:
            choice["detail"] = detail
        if recommended is not _MISSING:
            choice["recommended"] = recommended
        choices.append(choice)
    return choices


def parse_suggestions(text: str) -> List[str]:
    value = parse_json(text)
    if not isinstance(value, list):
        raise invalid("suggestions", SUGGESTIONS_EXPECTED)
    for index, item in enumerate(value):
        if not is_text(item):
            raise invalid("suggestions", f"suggestions[{index}] must be non-empty text.")
    return value


def parse_action(text: str) -> Dict[str, str]:
    value = parse_json(text)
    if not isinstance(value, dict) or not is_text(value.get("label")) or not is_text(value.get("url")):
        raise invalid("action", ACTION_EXPECTED)
    return {"label": value["label"], "url": value["url"]}


def parse_links(text: str) -> List[Dict[str, str]]:
    """Related files and pages for any ui: a label and exactly one of a path or an http(s) url."""
    value = parse_json(text)
    if not isinstance(value, list):
        raise invalid("links", LINKS_EXPECTED)
    if len(value) > MAX_LINKS:
        raise invalid("links", f"links takes up to {MAX_LINKS} links; got {len(value)}.")
    links: List[Dict[str, str]] = []
    for index, item in enumerate(value):
        path = item.get("path", _MISSING) if isinstance(item, dict) else _MISSING
        url = item.get("url", _MISSING) if isinstance(item, dict) else _MISSING
        if (
            not isinstance(item, dict)
            or not is_text(item.get("label"))
            or (path is not _MISSING and not isinstance(path, str))
            or (url is not _MISSING and not isinstance(url, str))
        ):
            raise invalid("links", f'links[{index}] must be an object with a non-empty "label" and one of "path" or "url".')
        label = item["label"]
        if len(label) > MAX_LINK_LABEL:
            raise invalid("links", f"links[{index}] label takes up to {MAX_LINK_LABEL} characters; got {len(label)}.")
        if path is not _MISSING and url is not _MISSING:
            raise invalid("links", f'links[{index}] has both "path" and "url"; give one.')
        if path is not _MISSING:
            if not is_text(path):
                raise invalid("links", f"links[{index}] path must be non-empty text.")
            links.append({"label": label, "path": path})
            continue
        if url is _MISSING:
            raise invalid("links", f'links[{index}] needs one of "path" (a file) or "url" (a web page).')
        if not LINK_URL.fullmatch(url):
            raise invalid("links", f"links[{index}] url must start with http:// or https://.")
        links.append({"label": label, "url": url})
    return links


def parse_json(text: str) -> Any:
    """Malformed JSON reads as a missing value, which every shape check then rejects with its own message."""
    try:
        return json.loads(text)
    except ValueError:
        return _MISSING


def is_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def describe_notify_result(result: Dict[str, Any]) -> str:
    """One line for people: the answer, Approved or Denied, where an update went, or what to do next."""

    def with_note(text: str) -> str:
        return f"{text}. Note: {result['note']}" if result.get("note") else text

    if "waiting" in result:
        return f"Still waiting (id {result.get('id')}). {result.get('next')}"
    if "unavailable" in result:
        return f"Unavailable: {result.get('unavailable')} {result.get('next')}"
    if "approved" in result:
        return with_note("Approved" if result["approved"] else "Denied")
    if "answer" in result:
        return with_note(f"Answer: {result['answer']}")
    if "status" in result:
        return f"Saved as {result.get('project')}/{result.get('name')}" if result["status"] == "saved" else "Declined"
    return "Shown on screen." if result.get("delivered") == "screen" else "Added to the Notify inbox."


def run_notify(parsed: Any, env: Optional[Mapping[str, str]] = None) -> int:
    """Shows the question and waits, with no time limit, for the answer; unavailable when Pane is not running."""
    request = build_notify_request(parsed, os.environ if env is None else env, os.getcwd())
    try:
        result = invoke_daemon("runpane:notify", [request], pane_dir=parsed.pane_dir, timeout_ms=math.inf)
    except PaneDaemonClientError as error:
        # An older Pane, or the headless daemon, has no notify channel.
        if error.connection_failure:
            reason = "Pane is not running."
        elif error.code == "ERR_UNKNOWN_CHANNEL":
            reason = "This Pane doesn't support notify yet."
        else:
            raise
        result = {"unavailable": reason, "next": UNAVAILABLE_NEXT}
    print(json.dumps(result, indent=2) if parsed.json else describe_notify_result(result))
    return 0
