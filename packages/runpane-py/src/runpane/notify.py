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
MIN_QUESTIONS = 2
MAX_QUESTIONS = 4
TOOK_AS = ["answer", "question"]
MAX_DETAIL_LABEL = 40
MAX_LINKS = 6
MAX_LINK_LABEL = 80
LINK_URL = re.compile(r"https?://\S+")
# Each optional field and the one ui it belongs to.
FIELD_UI = [("choices", "options"), ("questions", "options"), ("detail", "approve"), ("detailLabel", "approve"), ("suggestions", "ask"), ("action", "info")]
CHOICES_EXPECTED = 'choices must be a JSON array of choices, such as [{"label":"Ship it","recommended":true},{"label":"Wait"}].'
SUGGESTIONS_EXPECTED = 'suggestions must be a JSON array of strings, such as ["main","release"].'
ACTION_EXPECTED = 'action must be a JSON object with a non-empty "label" and "url", such as {"label":"Open PR","url":"https://github.com/org/repo/pull/1"}.'
QUESTIONS_EXPECTED = 'questions must be a JSON array of 2 to 4 questions, such as [{"title":"Release notes","choices":[{"label":"Ship"},{"label":"Hold"}]},{"title":"Intel build","choices":[{"label":"Include"},{"label":"Skip"}]}].'
LINKS_EXPECTED = 'links must be a JSON array of links, such as [{"label":"Notes","path":"docs/RELEASE.md"},{"label":"PR #1","url":"https://github.com/org/repo/pull/1"},{"label":"Q-19","approval":"Q-19"}].'
# The question fields `--update` may change; the approval keeps its ui and the rest.
UPDATE_FIELDS = {"title", "context", "choices", "questions", "links"}
QUESTION_FIELDS = ("ui", "title", "context", "choices", "questions", "detail", "detailLabel", "suggestions", "action", "links")
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
        "questions": parsed.notify_questions,
        "detail": parsed.notify_detail,
        "detailLabel": parsed.notify_detail_label,
        "suggestions": parsed.notify_suggestions,
        "action": parsed.notify_action,
        "links": parsed.notify_links,
    }
    others = {
        "relays": parsed.notify_relays,
        "aboutSession": parsed.notify_about_session,
        "took": parsed.notify_took,
        "tookAs": parsed.notify_took_as,
        "status": parsed.notify_status,
        "update": parsed.notify_update,
        "asked": parsed.notify_asked,
        "whatChanged": parsed.notify_what_changed,
    }
    caller, timing = notify_caller_fields(env, cwd)

    if parsed.resume is not None:
        if not parsed.resume.strip():
            raise invalid("resume", "resume must be the id from a waiting result.")
        extra = given_fields({**given, **others})
        if extra:
            raise invalid("resume", f"resume keeps waiting on an earlier question, so it takes no other fields; remove {', '.join(extra)}.", "Call notify again with only resume.")
        return {"resume": parsed.resume, **timing, "caller": caller}
    if others["took"] is not None or others["tookAs"] is not None:
        return build_took_request(given, others, caller)
    if others["status"] is not None:
        raise invalid("status", "status goes with --took <id|Q-n> question.")
    if others["update"] is not None:
        return {**build_update_request(others["update"], given, others), **timing, "caller": caller}
    for field in ("asked", "whatChanged"):
        if others[field] is not None:
            raise invalid(field, f"{field} goes with --update <id|Q-n>, which saves a new version of an approval.")

    request: Dict[str, Any] = {**parse_notify_question(given), **timing, "caller": caller}
    if others["relays"] is not None:
        if not others["relays"].strip():
            raise invalid("relays", "relays must be the id of a waiting item from runpane inbox.")
        request["relays"] = others["relays"]
    if others["aboutSession"] is not None:
        if not others["aboutSession"].strip():
            raise invalid("aboutSession", "aboutSession must be a Session id or name.")
        request["aboutSession"] = others["aboutSession"]
    return request


def given_fields(fields: Mapping[str, Optional[str]], keep: Tuple[str, ...] = ()) -> List[str]:
    """The fields given, in order, leaving out those in `keep`."""
    return [field for field, value in fields.items() if value is not None and field not in keep]


def build_took_request(given: Mapping[str, Optional[str]], others: Mapping[str, Optional[str]], caller: Dict[str, str]) -> Dict[str, Any]:
    """`--took <id|Q-n> answer|question`: how the reader took the person's reply. It asks nothing new."""
    took, took_as, status = others["took"], others["tookAs"], others["status"]
    if took is None:
        raise invalid("tookAs", "tookAs goes with took: --took <id|Q-n> answer|question.")
    if not took.strip():
        raise invalid("took", "took must be the approval's id or Q-n, such as --took Q-20 answer.")
    if took_as is None:
        raise invalid("took", "took needs answer or question after the id: answer if the reply answers the question, question if it asks one.")
    if took_as not in TOOK_AS:
        raise invalid("took", f'took takes answer or question after the id; got "{took_as}".')
    extra = given_fields({**given, **others}, ("took", "tookAs", "status"))
    if extra:
        raise invalid("took", f"took records how a reply was taken, so it takes no other fields; remove {', '.join(extra)}.")
    request: Dict[str, Any] = {"took": took, "tookAs": took_as, "caller": caller}
    if status is not None:
        if took_as != "question":
            raise invalid("status", "status says what you are doing about a question, so it goes with --took <id> question.")
        if not status.strip():
            raise invalid("status", 'status must be non-empty text, such as "Checking the logs".')
        request["status"] = status
    return request


def build_update_request(update: str, given: Mapping[str, Optional[str]], others: Mapping[str, Optional[str]]) -> Dict[str, Any]:
    """`--update`: a new version of an approval. Only the fields given change; it keeps its ui."""
    if not update.strip():
        raise invalid("update", "update must be the approval's id or Q-n, such as --update Q-20.")
    extra = given_fields({**given, **others}, (*sorted(UPDATE_FIELDS), "update", "asked", "whatChanged"))
    if extra:
        raise invalid("update", f"update changes only title, context, choices, questions and links, and keeps the approval's ui; remove {', '.join(extra)}.")
    if not (others["asked"] or "").strip():
        raise invalid("asked", "asked is required with update: the person's question, as they typed it.")
    if not (others["whatChanged"] or "").strip():
        raise invalid("whatChanged", 'whatChanged is required with update: one line per change, such as "Added: it can be undone from Settings".')
    if given["title"] is not None and not given["title"].strip():
        raise invalid("title", "title must be non-empty text; leave it out to keep the current one.")
    if given["choices"] is not None and given["questions"] is not None:
        raise invalid("questions", "questions asks several questions in place of choices; give choices or questions, not both.")
    request: Dict[str, Any] = {"update": update, "asked": others["asked"], "whatChanged": others["whatChanged"]}
    if given["title"] is not None:
        request["title"] = given["title"]
    if given["context"] is not None:
        request["context"] = given["context"]
    if given["choices"] is not None:
        request["choices"] = parse_choices(parse_json(given["choices"]), "choices", "choices", True)
    if given["questions"] is not None:
        request["questions"] = parse_questions(given["questions"], True)
    if given["links"] is not None:
        request["links"] = parse_links(given["links"])
    return request


def parse_notify_question(given: Mapping[str, Optional[str]]) -> Dict[str, Any]:
    """Checks a question's fields, for notify and for Autopilot's rewrite of an item. Fields left out read as not given."""
    given = {field: given.get(field) for field in QUESTION_FIELDS}
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
    if ui == "options" and given["choices"] is not None and given["questions"] is not None:
        raise invalid("questions", "questions asks several questions in place of choices; give choices or questions, not both.")
    if ui == "options" and given["choices"] is None and given["questions"] is None:
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
        question["choices"] = parse_choices(parse_json(given["choices"]), "choices", "choices", False)
    if given["questions"] is not None:
        question["questions"] = parse_questions(given["questions"], False)
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


def parse_choices(value: Any, field: str, where: str, allow_was: bool) -> List[Dict[str, Any]]:
    """1 to 9 choices with distinct labels; `where` names them in messages, and `was` is only for `--update`."""
    if not isinstance(value, list):
        raise invalid(field, CHOICES_EXPECTED if field == "choices" else f"{where} must be a JSON array of 1 to {MAX_CHOICES} choices.")
    if len(value) < 1 or len(value) > MAX_CHOICES:
        raise invalid(field, f"{where} takes 1 to {MAX_CHOICES} choices; got {len(value)}.")
    choices: List[Dict[str, Any]] = []
    labels = set()
    for index, item in enumerate(value):
        detail = item.get("detail", _MISSING) if isinstance(item, dict) else _MISSING
        recommended = item.get("recommended", _MISSING) if isinstance(item, dict) else _MISSING
        was = item.get("was", _MISSING) if isinstance(item, dict) else _MISSING
        if (
            not isinstance(item, dict)
            or not is_text(item.get("label"))
            or (detail is not _MISSING and not isinstance(detail, str))
            or (recommended is not _MISSING and not isinstance(recommended, bool))
            or (was is not _MISSING and not is_text(was))
        ):
            raise invalid(field, f'{where}[{index}] must be an object with a non-empty "label", and optionally "detail" (text) and "recommended" (true or false).')
        if was is not _MISSING and not allow_was:
            raise invalid(field, f'{where}[{index}] has "was", the old label of a reworded choice, which only --update takes.')
        label = item["label"]
        if label in labels:
            raise invalid(field, f'{where}[{index}] repeats the label "{label}"; each choice needs its own label.')
        labels.add(label)
        choice: Dict[str, Any] = {"label": label}
        if detail is not _MISSING:
            choice["detail"] = detail
        if recommended is not _MISSING:
            choice["recommended"] = recommended
        if was is not _MISSING:
            choice["was"] = was
        choices.append(choice)
    return choices


def parse_questions(text: str, allow_was: bool) -> List[Dict[str, Any]]:
    """ui options, instead of choices: 2 to 4 questions, each with its own choices and one pick."""
    value = parse_json(text)
    if not isinstance(value, list):
        raise invalid("questions", QUESTIONS_EXPECTED)
    if len(value) < MIN_QUESTIONS or len(value) > MAX_QUESTIONS:
        raise invalid("questions", f"questions takes {MIN_QUESTIONS} to {MAX_QUESTIONS} questions; got {len(value)}. For one question, use choices.")
    questions: List[Dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not is_text(item.get("title")) or "choices" not in item:
            raise invalid("questions", f'questions[{index}] must be an object with a non-empty "title" and "choices", a JSON array of 1 to {MAX_CHOICES} choices.')
        questions.append({"title": item["title"], "choices": parse_choices(item["choices"], "questions", f"questions[{index}].choices", allow_was)})
    return questions


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
    """Related files, pages and approvals for any ui: a label and exactly one of a path, an http(s) url, or an approval."""
    value = parse_json(text)
    if not isinstance(value, list):
        raise invalid("links", LINKS_EXPECTED)
    if len(value) > MAX_LINKS:
        raise invalid("links", f"links takes up to {MAX_LINKS} links; got {len(value)}.")
    links: List[Dict[str, str]] = []
    for index, item in enumerate(value):
        targets = {key: item.get(key, _MISSING) if isinstance(item, dict) else _MISSING for key in ("path", "url", "approval")}
        if (
            not isinstance(item, dict)
            or not is_text(item.get("label"))
            or any(target is not _MISSING and not isinstance(target, str) for target in targets.values())
        ):
            raise invalid("links", f'links[{index}] must be an object with a non-empty "label" and one of "path", "url" or "approval".')
        label = item["label"]
        if len(label) > MAX_LINK_LABEL:
            raise invalid("links", f"links[{index}] label takes up to {MAX_LINK_LABEL} characters; got {len(label)}.")
        if sum(1 for target in targets.values() if target is not _MISSING) > 1:
            raise invalid("links", f'links[{index}] has more than one of "path", "url" and "approval"; give one.')
        path, url, approval = targets["path"], targets["url"], targets["approval"]
        if path is not _MISSING:
            if not is_text(path):
                raise invalid("links", f"links[{index}] path must be non-empty text.")
            links.append({"label": label, "path": path})
            continue
        if approval is not _MISSING:
            if not is_text(approval):
                raise invalid("links", f"links[{index}] approval must be another approval's id or Q-n.")
            links.append({"label": label, "approval": approval})
            continue
        if url is _MISSING:
            raise invalid("links", f'links[{index}] needs one of "path" (a file), "url" (a web page) or "approval" (another approval\'s id or Q-n).')
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
    """One line for people: the answer or reply, Approved or Denied, where an update went, or what to do next."""

    def with_note(text: str) -> str:
        return f"{text}. Note: {result['note']}" if result.get("note") else text

    if "waiting" in result:
        return f"Still waiting (id {result.get('id')}). {result.get('next')}"
    if "reply" in result:
        # Picks keep their question's place: one left unpicked reads "—".
        picks = result.get("picks") or []
        picked = f" (picked: {' · '.join(pick or '—' for pick in picks)})" if any(picks) else ""
        return f'Reply {result.get("replyId")} on {result.get("id")}: "{result["reply"]}"{picked}. {result.get("next")}'
    if "took" in result:
        taken = "the answer" if result["took"] == "answer" else "a question"
        return f"Taken as {taken} (id {result.get('id')})." + (f" {result['next']}" if result.get("next") else "")
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
