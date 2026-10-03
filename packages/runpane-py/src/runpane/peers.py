from __future__ import annotations

import json
import os
import sys
from typing import TYPE_CHECKING

from .daemon_client import invoke_daemon

if TYPE_CHECKING:
    from .cli import ParsedArgs


def run_peers(parsed: ParsedArgs) -> int:
    action = parsed.command.split(" ")[1]
    if parsed.dry_run:
        raise ValueError("Peer commands do not support --dry-run; use self, list or an unclaimed inbox to inspect.")
    if parsed.follow and action != "wait":
        raise ValueError("--follow is supported only by peers wait.")
    if parsed.follow and parsed.timeout_ms == 0:
        raise ValueError("--follow requires a positive timeout.")
    if parsed.panel_input is not None and parsed.panel_input_file is not None:
        raise ValueError("Use either --text or --input-file.")
    text = parsed.panel_input
    if parsed.panel_input_file == "-":
        text = sys.stdin.read()
    elif parsed.panel_input_file is not None:
        with open(parsed.panel_input_file, encoding="utf-8") as source:
            text = source.read()
    request = {key: value for key, value in {
        "action": action,
        "peer": parsed.peer or os.environ.get("PANE_PEER_ID") or os.environ.get("PANE_PANEL_ID"),
        "to": parsed.peer_to, "id": parsed.message_id, "agent": parsed.agent_label,
        "receiver": parsed.receiver, "status": parsed.reply_status, "text": text,
        "claim": parsed.claim, "includeReceived": parsed.include_received,
        "after": parsed.after_revision, "timeoutMs": parsed.timeout_ms,
        "limit": parsed.limit, "confirmed": parsed.yes,
    }.items() if value is not None}
    while True:
        result = invoke_daemon("runpane:peers", [request], pane_dir=parsed.pane_dir,
                               timeout_ms=(parsed.timeout_ms if parsed.timeout_ms is not None else 60_000) + 10_000,
                               event_include=[])
        if not isinstance(result, dict) or result.get("protocolVersion") != 1:
            raise ValueError("Unsupported peer protocol response.")
        if parsed.follow and result.get("timedOut") is True:
            continue
        print(json.dumps(result, indent=None if parsed.json else 2, ensure_ascii=False), flush=True)
        return 0
