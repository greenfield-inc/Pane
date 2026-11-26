"""`runpane reply` and `runpane messages ...`: agent-to-agent messages (T-104), over the Pane daemon, like the npm CLI."""
from __future__ import annotations

import json
import math
import os
import re
import sys
from typing import Any, Dict

from .daemon_client import invoke_daemon
from .notify import RunpaneError

MESSAGE_REF_PATTERN = re.compile(r"\s*(?:[mM]-?)?([0-9]+)\s*")
LIST_NEXT = "Copy the id from the message's reply line, or see recent ones with `runpane messages list`."
MAX_SAFE_INTEGER = 2**53 - 1
# Exit code for a wait that ran out, as `--wait` uses.
TIMEOUT_EXIT = 124


def invalid(message: str, next_step: str) -> RunpaneError:
    return RunpaneError("ERR_RUNPANE_INVALID_ARGUMENT", f"{message} Nothing was sent.", next_step)


def message_ref_from(parsed: Any) -> str:
    """"M-12", "m12" or "12" as "M-12"."""
    words = parsed.message_args
    if not words:
        raise invalid(f"runpane {parsed.command} needs the message id, such as M-12.", LIST_NEXT)
    match = MESSAGE_REF_PATTERN.fullmatch(words[0])
    number = int(match.group(1)) if match else 0
    if number < 1 or number > MAX_SAFE_INTEGER:
        raise invalid(f'"{words[0]}" is not a message id; a message id is M-12.', LIST_NEXT)
    return f"M-{number}"


def only_message_ref(parsed: Any) -> str:
    ref = message_ref_from(parsed)
    extra = parsed.message_args[1:]
    if extra:
        raise invalid(f"runpane {parsed.command} takes one message id, but also got: {' '.join(extra)}.", f"Run runpane {parsed.command} {ref}.")
    return ref


def reply_text(parsed: Any, ref: str) -> str:
    words = parsed.message_args[1:]
    if parsed.panel_input_file is not None:
        if words:
            raise invalid("Pass the reply as text or with --input-file, not both.", f"Run runpane reply {ref} \"…\" or runpane reply {ref} --input-file <path>.")
        if parsed.panel_input_file == "-":
            return sys.stdin.read()
        with open(parsed.panel_input_file, encoding="utf-8") as handle:
            return handle.read()
    text = " ".join(words).strip()
    if not text:
        raise invalid(
            f'runpane reply needs the reply after the message id, such as `runpane reply {ref} "Yes, until Friday."`.',
            "Pass the reply in quotes after the message id, or use --input-file.",
        )
    return text


def caller_fields() -> Dict[str, str]:
    panel_id = (os.environ.get("PANE_PANEL_ID") or "").strip()
    return {"callerPanelId": panel_id} if panel_id else {}


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def describe(message: Dict[str, Any]) -> str:
    why = f": {message['undeliveredReason']}" if message.get("state") == "undelivered" and message.get("undeliveredReason") else ""
    reply_to = f" reply to {message['replyTo']}" if message.get("replyTo") else ""
    replies = f" · replies {', '.join(message['replies'])}" if message.get("replies") else ""
    first = (message.get("text") or "").split("\n")[0]
    return f"{message['ref']}{reply_to} {message['sender']['name']} → {message['receiver']['name']} · {message['state']}{why}{replies}\n  {first}"


def wait_for_message_reply(parsed: Any, ref: str) -> int:
    """`--await-reply` and `runpane messages wait`: block until the first reply comes, print it, exit 0; 124 after --timeout. Pane types it into the tab too."""
    request: Dict[str, Any] = {"message": ref}
    if parsed.wait_timeout_ms:
        request["timeoutMs"] = parsed.wait_timeout_ms
    result = invoke_daemon("runpane:messages:wait", [request], pane_dir=parsed.pane_dir, timeout_ms=math.inf)
    reply = result.get("reply")
    if parsed.json:
        print_json(result)
    elif reply:
        print(f'reply: {ref} → "{reply["text"]}" (from {reply["sender"]["name"]}) [{reply["ref"]}]')
    else:
        print(f"No reply to {ref} yet.{' ' + result['next'] if result.get('next') else ''}")
    return 0 if result.get("outcome") == "reply" else TIMEOUT_EXIT


def run_messages(parsed: Any) -> int:
    command = parsed.command
    if command == "reply":
        ref = message_ref_from(parsed)
        result = invoke_daemon("runpane:reply", [{"message": ref, "text": reply_text(parsed, ref), **caller_fields()}], pane_dir=parsed.pane_dir)
        if parsed.json:
            print_json(result)
        else:
            delivery = result.get("delivery")
            where = "Delivered" if delivery == "delivered" else "Queued" if delivery == "queued" else "Could not deliver"
            print(f"{where} {result['reply']['ref']}, the reply to {ref}, to {result['reply']['receiver']['name']}.")
            if result.get("next"):
                print(f"Next: {result['next']}")
        return 1 if result.get("delivery") == "undelivered" else 0
    if command == "messages list":
        request: Dict[str, Any] = caller_fields()
        if parsed.panel_id is not None:
            request["panelId"] = parsed.panel_id
        if parsed.all:
            request["all"] = True
        if parsed.limit is not None:
            request["limit"] = parsed.limit
        result = invoke_daemon("runpane:messages:list", [request], pane_dir=parsed.pane_dir)
        if parsed.json:
            print_json(result)
        else:
            messages = result.get("messages") or []
            print("\n".join(describe(message) for message in messages) if messages else "No messages.")
        return 0
    if command == "messages show":
        result = invoke_daemon("runpane:messages:show", [{"message": only_message_ref(parsed)}], pane_dir=parsed.pane_dir)
        if parsed.json:
            print_json(result)
        else:
            print("\n".join([describe(result["message"]), *(describe(reply) for reply in result.get("replies") or [])]))
        return 0
    if command == "messages wait":
        return wait_for_message_reply(parsed, only_message_ref(parsed))
    raise ValueError(f"run_messages does not handle {command}.")
