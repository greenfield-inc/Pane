"""`runpane autopilot`: read Autopilot's state and what waits on the person, add to its stack, and answer, close or rewrite items."""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

from .daemon_client import PaneDaemonClientError, invoke_daemon
from .notify import RunpaneError, parse_notify_question

URL_TAB = re.compile(r"^https?://", re.IGNORECASE)


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))


def plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def format_age(age_ms: float) -> str:
    """`45s`, `12m`, `3h`, `2d`: how long an item has waited."""
    seconds = max(0, int(age_ms // 1000))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h"
    return f"{hours // 24}d"


def run_autopilot_status(parsed: Any) -> int:
    result = invoke_daemon("runpane:autopilot:status", [], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    enabled = bool(result.get("enabled"))
    print(f"Autopilot is on and {result.get('state')}." if enabled else "Autopilot is off. Turn it on in Settings > Advanced > Experimental > Autopilot.")
    if enabled and result.get("sentinel"):
        print("Sentinel is on: Autopilot keeps your Sessions moving while you are away.")
    entitlement = result.get("entitlement") or {}
    if not entitlement.get("entitled"):
        reason = entitlement.get("reason") or "This account cannot use Autopilot."
        next_step = entitlement.get("next")
        print(f"Not available: {reason}" + (f" Next: {next_step}" if next_step else ""))
    if enabled and not result.get("chatTabsEnabled"):
        print("Chat tabs are off; Autopilot runs as a chat tab, so it needs them on.")
    run = result.get("run")
    if run:
        print(f"Run {run.get('id')}: {run.get('folder')}")
    if result.get("panelId"):
        owner = result.get("ownerPaneId")
        print(f"Chat tab: panel {result.get('panelId')}" + (f" in pane {owner}" if owner else ""))
    stack = result.get("stack") or {}
    entries = stack.get("entries") or []
    shown = next((entry for entry in entries if entry.get("id") == stack.get("shownId")), None)
    print(f"Stack: {plural(len(entries), 'entry', 'entries')}" + (f"; showing \"{shown.get('title')}\"" if shown else "") + ".")
    walk = result.get("walk") or {}
    sessions = walk.get("sessions") or []
    walking = next((session for session in sessions if session.get("id") == walk.get("sessionId")), None)
    waiting = sum(int(session.get("waiting") or 0) for session in sessions)
    sessions_waiting = len([session for session in sessions if (session.get("waiting") or 0) > 0])
    print(
        f"Waiting: {plural(waiting, 'item', 'items')} in {plural(sessions_waiting, 'Session', 'Sessions')}"
        + (f"; the walk is on {walking.get('name')}" if walking else "")
        + "."
    )
    return 0


def run_autopilot_waiting(parsed: Any) -> int:
    result = invoke_daemon("runpane:autopilot:waiting", [], pane_dir=parsed.pane_dir)
    items = result.get("items") or []
    # An older Pane marks a worker's question "stuck"; here it reads as the question it is.
    for item in items:
        if item.get("kind") == "stuck":
            item["kind"] = "question"
    if parsed.json:
        print_json(result)
        return 0
    if not items:
        print("Nothing is waiting on the person.")
    group: Optional[str] = None
    for item in items:
        key = item.get("sessionId") or ""
        if key != group:
            group = key
            print(f"{item.get('sessionName') or key} ({key})" if key else "Not in a Session")
        marks = "".join([
            "" if item.get("machineId") == "local" else f"  on {item.get('machine')}",
            "  on the stack" if item.get("onStack") else "",
            "  stale" if item.get("stale") else "",
            "  quiet" if item.get("quiet") else "",
            "  reopened by you" if item.get("reopened") else "",
        ])
        print(f"  {item.get('id')}  {item.get('kind')}  {item.get('title')}  {item.get('agent')} - {item.get('pane')}  {format_age(item.get('ageMs') or 0)}{marks}")
    for machine in result.get("offline") or []:
        print(f"{machine} offline")
    for machine in result.get("cantSee") or []:
        print(f"Can't see: {machine}")
    return 0


def run_autopilot_stack(parsed: Any) -> int:
    result = invoke_daemon("runpane:autopilot:stack", [], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    entries = result.get("entries") or []
    if not entries:
        print("The stack is empty.")
        return 0
    print(f"Stack: {plural(len(entries), 'entry', 'entries')}.")
    for index, entry in enumerate(entries):
        shown = entry.get("id") == result.get("shownId")
        session = f" - {entry.get('sessionName')}" if entry.get("sessionName") else ""
        done = " (done)" if entry.get("doneAt") is not None else ""
        print(f"{'>' if shown else ' '} {index + 1}. {entry.get('id')} {(entry.get('ref') or {}).get('kind')}: {entry.get('title')}{session}{done}{' (shown)' if shown else ''}")
    return 0


def build_stack_push_request(parsed: Any, cwd: str) -> Dict[str, Any]:
    """Files (the entry's and its tabs') resolve against `cwd`; a tab starting with http(s):// is a URL."""
    request: Dict[str, Any] = {}
    if parsed.item is not None:
        request["item"] = parsed.item
    if parsed.file is not None:
        request["file"] = os.path.abspath(os.path.join(cwd, parsed.file))
    if parsed.url is not None:
        request["url"] = parsed.url
    if parsed.session_id is not None:
        request["session"] = parsed.session_id
    if parsed.title is not None:
        request["title"] = parsed.title
    if parsed.note is not None:
        request["note"] = parsed.note
    if parsed.stack_tabs:
        tabs: List[Dict[str, str]] = []
        for tab in parsed.stack_tabs:
            tabs.append({"url": tab} if URL_TAB.match(tab) else {"path": os.path.abspath(os.path.join(cwd, tab))})
        request["tabs"] = tabs
    if parsed.stack_next:
        request["next"] = True
    return request


def run_autopilot_stack_push(parsed: Any, cwd: Optional[str] = None) -> int:
    request = build_stack_push_request(parsed, cwd or os.getcwd())
    result = invoke_daemon("runpane:autopilot:stack-push", [request], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    entry = result.get("entry")
    title = f"\"{entry.get('title')}\"" if entry else "it"
    where = f"({result.get('position')} of {result.get('total')})"
    if result.get("shown"):
        print(f"On the stack and on screen: {title} {where}.")
    else:
        print(f"On the stack: {title} {where}; it comes up when the person is done with the one on screen.")
    return 0


def invalid_action(message: str, next_step: str) -> RunpaneError:
    return RunpaneError("ERR_AUTOPILOT_INVALID", f"{message} Nothing was changed.", next_step)


def require_item(parsed: Any, verb: str) -> str:
    """The `<id>` every action takes, from `runpane autopilot waiting`."""
    if not (parsed.item or "").strip():
        raise invalid_action(f"runpane autopilot {verb} needs a waiting item's id.", "List what waits with runpane autopilot waiting --json and pass an id from it.")
    return parsed.item


def build_answer_request(parsed: Any) -> Dict[str, Any]:
    item = require_item(parsed, "answer")
    ways = [parsed.answer_choice is not None, parsed.answer_approve, parsed.answer_deny, parsed.panel_input is not None]
    if sum(1 for way in ways if way) != 1:
        raise invalid_action("runpane autopilot answer needs exactly one of --choice <label>, --approve, --deny, or --text <text>.", "Pass one way of answering.")
    if not (parsed.because or "").strip():
        raise invalid_action("runpane autopilot answer needs --because <why>: a D-n, a document or the person's words, recorded on the item.", "Say why with --because. If you have no reason to give, bring the item to the person instead.")
    note = {} if parsed.note is None else {"note": parsed.note}
    if parsed.panel_input is not None:
        if parsed.note is not None:
            raise invalid_action("--note goes with --choice, --approve or --deny.", "Put the note in --text.")
        if not parsed.panel_input.strip():
            raise invalid_action("--text must be non-empty.", "Pass the answer in --text.")
        answer: Dict[str, Any] = {"text": parsed.panel_input}
    elif parsed.answer_choice is not None:
        if not parsed.answer_choice.strip():
            raise invalid_action("--choice must be one of the item's labels.", "Read its choices with runpane autopilot waiting --json.")
        answer = {"choice": parsed.answer_choice, **note}
    else:
        answer = {"approved": bool(parsed.answer_approve), **note}
    return {"id": item, "answer": answer, "because": parsed.because}


def build_close_request(parsed: Any) -> Dict[str, Any]:
    item = require_item(parsed, "close")
    if not (parsed.reason or "").strip():
        raise invalid_action("runpane autopilot close needs --reason <why>, recorded on the item and told to its asker.", "Say why with --reason.")
    return {"id": item, "reason": parsed.reason}


def build_rewrite_request(parsed: Any, cwd: str) -> Dict[str, Any]:
    """Links' files resolve against `cwd`, so Pane gets absolute paths, as `stack push` does."""
    item = require_item(parsed, "rewrite")
    if parsed.notify_detail is not None or parsed.notify_detail_label is not None or parsed.notify_action is not None:
        raise invalid_action("runpane autopilot rewrite takes --context, --choices, --suggestions and --links, not --detail, --detail-label or --action.", "Put what the person needs to read in --context.")
    if parsed.notify_ui == "info":
        raise invalid_action("A rewrite must take an answer, so --ui info doesn't fit.", "Use --ui options, approve, or ask.")
    try:
        question = parse_notify_question({
            "ui": parsed.notify_ui,
            "title": parsed.title,
            "context": parsed.notify_context,
            "choices": parsed.notify_choices,
            "suggestions": parsed.notify_suggestions,
            "links": parsed.notify_links,
        })
    except RunpaneError as error:
        raise RunpaneError("ERR_AUTOPILOT_INVALID", str(error), "Fix it and run runpane autopilot rewrite again.") from error
    if "links" in question:
        question["links"] = [{**link, "path": os.path.abspath(os.path.join(cwd, link["path"]))} if "path" in link else link for link in question["links"]]
    return {"id": item, **question}


def act(parsed: Any, verb: str, request: Dict[str, Any]) -> Dict[str, Any]:
    """Answer, close and rewrite: an older Pane has no such channel."""
    try:
        return invoke_daemon(f"runpane:autopilot:{verb}", [request], pane_dir=parsed.pane_dir)
    except PaneDaemonClientError as error:
        if error.code == "ERR_UNKNOWN_CHANNEL":
            raise RunpaneError("ERR_AUTOPILOT_PANE_TOO_OLD", f"This Pane can't run runpane autopilot {verb} yet. Nothing was changed.", "Update Pane, or bring the item to the person.") from error
        raise


def on_machine(result: Dict[str, Any]) -> str:
    return f" on {result['machine']}" if result.get("machine") else ""


def run_autopilot_answer(parsed: Any) -> int:
    """Delivered at once, and recorded "by Autopilot" on the item."""
    request = build_answer_request(parsed)
    result = act(parsed, "answer", request)
    if parsed.json:
        print_json(result)
    else:
        print(f"Answered {result.get('id')}{on_machine(result)}, recorded by Autopilot because {request['because']}. The person can Override it.")
    return 0


def run_autopilot_close(parsed: Any) -> int:
    """Its asker is told, and the person can reopen it."""
    request = build_close_request(parsed)
    result = act(parsed, "close", request)
    if parsed.json:
        print_json(result)
    else:
        print(f"Closed {result.get('id')}{on_machine(result)}: {request['reason']}. The person can reopen it.")
    return 0


def run_autopilot_rewrite(parsed: Any, cwd: Optional[str] = None) -> int:
    """Closes the item and re-asks it; the answer goes to the original asker."""
    request = build_rewrite_request(parsed, cwd or os.getcwd())
    result = act(parsed, "rewrite", request)
    if parsed.json:
        print_json(result)
    else:
        print(f"Rewrote {request['id']} as {result.get('id')}{on_machine(result)}. Its answer goes to the original asker.")
    return 0
