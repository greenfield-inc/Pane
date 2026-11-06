"""`runpane autopilot`: read Autopilot's state and what waits on the person, and add to its stack."""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

from .daemon_client import invoke_daemon

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
    if parsed.json:
        print_json(result)
        return 0
    items = result.get("items") or []
    if not items:
        print("Nothing is waiting on the person.")
        return 0
    group: Optional[str] = None
    for item in items:
        key = item.get("sessionId") or ""
        if key != group:
            group = key
            print(f"{item.get('sessionName') or key} ({key})" if key else "Not in a Session")
        marker = "  on the stack" if item.get("onStack") else ""
        print(f"  {item.get('id')}  {item.get('kind')}  {item.get('title')}  {item.get('agent')} - {item.get('pane')}  {format_age(item.get('ageMs') or 0)}{marker}")
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
