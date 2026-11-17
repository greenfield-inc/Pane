"""`runpane todos ...`: the to-do commands, over the Pane daemon's `runpane:todos:<verb>` channels, like the npm CLI."""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List

from .daemon_client import invoke_daemon
from .notify import RunpaneError

TODO_KEYS = ["ref", "number", "title", "state", "status", "reason", "parent", "sessionId", "requester", "assignee", "summary", "doneWhen", "attachmentCount", "updatedAt"]
ATTACHMENT_KEYS = ["id", "kind", "label", "target", "machine", "note", "addedBy", "source", "from", "addedAt"]
ACTIVITY_KEYS = ["id", "kind", "author", "body", "at"]
STATUS_LABELS = {
    "waiting": "Waiting on you",
    "working": "Working",
    "queued": "Queued",
    "idle": "Idle",
    "done": "Done",
    "dropped": "Dropped",
}
ATTACH_KINDS = ["plan", "mockup", "design", "pr", "findings", "decision", "doc", "image", "link"]
URL_PATTERN = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://")
TODO_REF_PATTERN = re.compile(r"\s*(?:[tT]-?)?([0-9]+)\s*")
LIST_NEXT = "See your to-dos with `runpane todos list`."
MAX_SAFE_INTEGER = 2**53 - 1


def invalid(message: str, next_step: str) -> RunpaneError:
    return RunpaneError("ERR_RUNPANE_INVALID_ARGUMENT", f"{message} Nothing was changed.", next_step)


def normalize_todo_ref(value: str, what: str) -> str:
    """"T-12", "t12" or "12" as "T-12"."""
    match = TODO_REF_PATTERN.fullmatch(value)
    number = int(match.group(1)) if match else 0
    if number < 1 or number > MAX_SAFE_INTEGER:
        raise invalid(f'{what} "{value}" is not a to-do; a to-do is T-12 or 12.', LIST_NEXT)
    return f"T-{number}"


def todo_ref_from(parsed: Any, extra: str) -> str:
    """The to-do, the first word; `extra` is "none" when the verb takes no other words."""
    words = parsed.todo_args
    if not words:
        raise invalid(f"runpane {parsed.command} needs the to-do, such as T-12.", LIST_NEXT)
    if extra == "none" and len(words) > 1:
        raise invalid(
            f"runpane {parsed.command} takes one to-do, but got {len(words)} words: {' '.join(words)}.",
            'Quote text and pass it with its option, such as --summary "...".',
        )
    return normalize_todo_ref(words[0], "The to-do")


def with_caller(request: Dict[str, Any]) -> Dict[str, Any]:
    caller = (os.environ.get("PANE_PANEL_ID") or "").strip()
    if caller:
        request["callerPanelId"] = caller
    return request


def attach_target(value: str) -> str:
    """A URL as given; a file path made absolute against the working directory."""
    return value if URL_PATTERN.match(value) else os.path.abspath(value)


def format_todo_line(todo: Dict[str, Any]) -> str:
    """`T-12  Working  Keyboard sheet · why`"""
    reason = f" · {todo['reason']}" if todo.get("reason") else ""
    status = todo.get("status")
    return f"{todo.get('ref')}  {STATUS_LABELS.get(status, status)}  {todo.get('title')}{reason}"


def one_line(text: str, limit: int = 200) -> str:
    line = re.sub(r"\s+", " ", text).strip()
    return f"{line[:limit - 1]}…" if len(line) > limit else line


def _todo_json(todo: Dict[str, Any]) -> Dict[str, Any]:
    result = {key: todo.get(key) for key in TODO_KEYS}
    result["doneWhen"] = [{"text": item.get("text"), "met": item.get("met")} for item in todo.get("doneWhen") or []]
    return result


def _attachment_json(attachment: Dict[str, Any]) -> Dict[str, Any]:
    return {key: attachment.get(key) for key in ATTACHMENT_KEYS}


def _activity_json(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {key: entry.get(key) for key in ACTIVITY_KEYS}


def _print_json(value: Dict[str, Any]) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def _call(parsed: Any, verb: str, request: Dict[str, Any]) -> Dict[str, Any]:
    return invoke_daemon(f"runpane:todos:{verb}", [request], pane_dir=parsed.pane_dir)


def _set(request: Dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        request[key] = value


def build_create(parsed: Any) -> Dict[str, Any]:
    title = " ".join(parsed.todo_args).strip()
    if not title:
        raise invalid('runpane todos create needs a title, such as `runpane todos create "Fix the login redirect"`.', "Pass the title as the first word, in quotes.")
    request: Dict[str, Any] = {"title": title}
    _set(request, "summary", parsed.summary)
    _set(request, "doneWhen", parsed.done_when)
    if parsed.todo_parent is not None:
        request["parent"] = normalize_todo_ref(parsed.todo_parent, "--parent")
    _set(request, "project", parsed.repo)
    _set(request, "agent", parsed.agent)
    if parsed.attachments:
        request["attach"] = [attach_target(value) for value in parsed.attachments]
    if parsed.no_start:
        request["start"] = False
    return with_caller(request)


def build_update(parsed: Any) -> Dict[str, Any]:
    request: Dict[str, Any] = {"todo": todo_ref_from(parsed, "none")}
    _set(request, "title", parsed.title)
    _set(request, "summary", parsed.summary)
    _set(request, "doneWhen", parsed.done_when)
    _set(request, "check", parsed.todo_check)
    _set(request, "uncheck", parsed.todo_uncheck)
    if len(request) == 1:
        raise invalid(
            "runpane todos update needs something to change: --title, --summary, --done-when, --check or --uncheck.",
            "Pass what changed, such as `runpane todos update T-12 --check 1`.",
        )
    return with_caller(request)


def build_attach(parsed: Any) -> Dict[str, Any]:
    todo = todo_ref_from(parsed, "one")
    words = parsed.todo_args
    if len(words) != 2 or not words[1].strip():
        raise invalid(
            "runpane todos attach takes the to-do and one file or URL, such as `runpane todos attach T-12 docs/plan.html`.",
            "Attach one file or URL at a time, and quote a path with spaces.",
        )
    if parsed.kind is not None and parsed.kind not in ATTACH_KINDS:
        raise invalid(f'--kind must be one of: {", ".join(ATTACH_KINDS)}; got "{parsed.kind}".', "Pick the nearest kind, or leave --kind out and Pane picks one.")
    request: Dict[str, Any] = {"todo": todo, "target": attach_target(words[1])}
    _set(request, "kind", parsed.kind)
    _set(request, "label", parsed.label)
    _set(request, "note", parsed.note)
    return with_caller(request)


def build_detach(parsed: Any) -> Dict[str, Any]:
    todo = todo_ref_from(parsed, "one")
    words = parsed.todo_args
    match = re.fullmatch(r"#?([0-9]+)", words[1]) if len(words) == 2 else None
    attachment = int(match.group(1)) if match else 0
    if attachment < 1 or attachment > MAX_SAFE_INTEGER:
        raise invalid(
            "runpane todos detach takes the to-do and an attachment id, such as `runpane todos detach T-12 3`.",
            "See attachment ids with `runpane todos show <todo>`.",
        )
    return with_caller({"todo": todo, "attachment": attachment})


def text_after_todo(parsed: Any, what: str, example: str) -> str:
    text = " ".join(parsed.todo_args[1:]).strip()
    if not text:
        raise invalid(f"runpane {parsed.command} needs the {what} after the to-do, such as `{example}`.", f"Pass the {what} in quotes after the to-do.")
    return text


def ref_request(parsed: Any) -> Dict[str, Any]:
    return with_caller({"todo": todo_ref_from(parsed, "none")})


def _emit(parsed: Any, result: Dict[str, Any], lines: List[str]) -> int:
    if parsed.json:
        _print_json(result)
    else:
        for line in lines:
            print(line)
    return 0


def _todo_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "todo": _todo_json(raw["todo"])}


def _print_todo(parsed: Any, verb: str, raw: Dict[str, Any]) -> int:
    result = _todo_result(raw)
    return _emit(parsed, result, [f"{verb} {format_todo_line(result['todo'])}"])


def run_todos(parsed: Any) -> int:
    command = parsed.command
    if command == "todos create":
        return _print_todo(parsed, "Created", _call(parsed, "create", build_create(parsed)))
    if command == "todos update":
        return _print_todo(parsed, "Updated", _call(parsed, "update", build_update(parsed)))
    if command == "todos attach":
        raw = _call(parsed, "attach", build_attach(parsed))
        result = {"ok": True, "todo": raw.get("todo"), "attachment": _attachment_json(raw["attachment"])}
        attachment = result["attachment"]
        return _emit(parsed, result, [f'Attached #{attachment["id"]} {attachment["kind"]} "{attachment["label"]}" to {result["todo"]}.'])
    if command == "todos detach":
        raw = _call(parsed, "detach", build_detach(parsed))
        result = {"ok": True, "todo": raw.get("todo"), "detached": raw.get("detached")}
        return _emit(parsed, result, [f"Detached #{result['detached']} from {result['todo']}."])
    if command == "todos show":
        raw = _call(parsed, "show", ref_request(parsed))
        result = {
            "ok": True,
            "todo": _todo_json(raw["todo"]),
            "attachments": [_attachment_json(item) for item in raw.get("attachments") or []],
            "subTodos": [_todo_json(item) for item in raw.get("subTodos") or []],
            "activity": [_activity_json(item) for item in raw.get("activity") or []],
        }
        return _emit(parsed, result, describe_show(result))
    if command == "todos list":
        return run_list(parsed)
    if command == "todos assign":
        request = ref_request(parsed)
        _set(request, "panel", parsed.panel_id)
        result = _todo_result(_call(parsed, "assign", request))
        assignee = result["todo"]["assignee"] or "its Session's orchestrator"
        return _emit(parsed, result, [f"{result['todo']['ref']} is assigned to {assignee}."])
    if command == "todos ask":
        todo = todo_ref_from(parsed, "text")
        request = with_caller({"todo": todo, "question": text_after_todo(parsed, "question", 'runpane todos ask T-12 "Which shortcuts?"')})
        raw = _call(parsed, "ask", request)
        result = {"ok": True, "todo": raw.get("todo"), "routedTo": raw.get("routedTo"), "approvalId": raw.get("approvalId")}
        who = "the person" if result["routedTo"] == "person" else "the requester"
        approval = f" (approval {result['approvalId']})" if result["approvalId"] else ""
        return _emit(parsed, result, [f"Asked {who} about {result['todo']}{approval}."])
    if command == "todos comment":
        todo = todo_ref_from(parsed, "text")
        request = with_caller({"todo": todo, "body": text_after_todo(parsed, "message", 'runpane todos comment T-12 "Sheet done."')})
        if parsed.escalate:
            request["escalate"] = True
        raw = _call(parsed, "comment", request)
        result = {"ok": True, "todo": raw.get("todo"), "activityId": raw.get("activityId")}
        line = f"Commented on {result['todo']} and asked the person." if parsed.escalate else f"Commented on {result['todo']}."
        return _emit(parsed, result, [line])
    if command == "todos review":
        request = ref_request(parsed)
        _set(request, "summary", parsed.summary)
        _set(request, "noAttachments", parsed.no_attachments)
        raw = _call(parsed, "review", request)
        result = {"ok": True, "todo": _todo_json(raw["todo"]), "approvalId": raw.get("approvalId")}
        return _emit(parsed, result, [f"Sent for review: {format_todo_line(result['todo'])} (approval {result['approvalId']})"])
    if command == "todos done":
        request = ref_request(parsed)
        _set(request, "personSaid", parsed.person_said)
        return _print_todo(parsed, "Closed", _call(parsed, "done", request))
    if command == "todos drop":
        request = ref_request(parsed)
        _set(request, "reason", parsed.reason)
        return _print_todo(parsed, "Dropped", _call(parsed, "drop", request))
    if command == "todos archive":
        raw = _call(parsed, "archive", ref_request(parsed))
        result = {
            "ok": True,
            "todo": raw.get("todo"),
            "archived": list(raw.get("archived") or []),
            "kept": [{"name": item.get("name"), "reason": item.get("reason")} for item in raw.get("kept") or []],
            "sessionArchived": raw.get("sessionArchived"),
        }
        return _emit(parsed, result, describe_archive(result))
    if command == "todos start":
        raw = _call(parsed, "start", ref_request(parsed))
        result = {"ok": True, "todo": _todo_json(raw["todo"]), "queued": raw.get("queued")}
        return _emit(parsed, result, [f"{'Queued' if result['queued'] else 'Started'} {format_todo_line(result['todo'])}"])
    if command == "todos stop":
        return _print_todo(parsed, "Stopped", _call(parsed, "stop", ref_request(parsed)))
    raise ValueError(f"Unsupported command: {command}")


def run_list(parsed: Any) -> int:
    if parsed.todo_args:
        raise invalid(f"runpane todos list takes no words, but got: {' '.join(parsed.todo_args)}.", "Show one to-do with `runpane todos show <todo>`.")
    request: Dict[str, Any] = {"all": True} if parsed.all else {}
    raw = _call(parsed, "list", request)
    result = {"ok": True, "todos": [_todo_json(item) for item in raw.get("todos") or []]}
    empty = f"{'No to-dos.' if parsed.all else 'No open to-dos.'} Create one with `runpane todos create \"<title>\"`."
    return _emit(parsed, result, [format_todo_line(todo) for todo in result["todos"]] or [empty])


def describe_show(result: Dict[str, Any]) -> List[str]:
    """Attachments first, then the to-do, its sub-to-dos and recent activity."""
    todo = result["todo"]
    lines: List[str] = []
    if not result["attachments"]:
        lines.append("Attachments: none")
    else:
        lines.append("Attachments:")
        for attachment in result["attachments"]:
            machine = f" on {attachment['machine']}" if attachment.get("machine") else ""
            source = f"  (from {attachment['from']})" if attachment.get("from") else ""
            lines.append(f"  #{attachment['id']}  {attachment['kind']}  {attachment['label']}  {attachment['target']}{machine}{source}")
            if attachment.get("note"):
                lines.append(f"      {one_line(attachment['note'])}")
    lines.append(format_todo_line(todo))
    parent = f" · sub-to-do of {todo['parent']}" if todo.get("parent") else ""
    lines.append(f"  Requested by {todo['requester']} · working: {todo['assignee'] or 'its Session' + chr(39) + 's orchestrator'}{parent}")
    for line in (todo.get("summary") or "").split("\n"):
        if line.strip():
            lines.append(f"  {line}")
    if todo["doneWhen"]:
        lines.append("  Done when:")
        for index, item in enumerate(todo["doneWhen"]):
            lines.append(f"    [{'x' if item['met'] else ' '}] {index + 1}. {item['text']}")
    if result["subTodos"]:
        lines.append("Sub-to-dos:")
        for sub in result["subTodos"]:
            lines.append(f"  {format_todo_line(sub)}")
    if result["activity"]:
        lines.append("Recent activity:")
        for entry in result["activity"]:
            lines.append(f"  {entry['at']}  {entry['author']}: {one_line(entry['body'])}")
    return lines


def describe_archive(result: Dict[str, Any]) -> List[str]:
    archived = f": {', '.join(result['archived'])}" if result["archived"] else ""
    lines = [f"Archived {result['todo']}{archived}."]
    for kept in result["kept"]:
        lines.append(f"Kept {kept['name']}: {kept['reason']}")
    if result["sessionArchived"]:
        lines.append("Archived its Session.")
    return lines

