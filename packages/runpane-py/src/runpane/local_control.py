from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .daemon_client import PaneDaemonClientError, invoke_daemon
from .generated_contract import RUNPANE_CONTRACT


def run_repos_list(parsed: Any) -> int:
    result = invoke_daemon("runpane:repos:list", pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    repos = result.get("repos", [])
    if not repos:
        print("No Pane repositories found.")
        return 0

    for repo in repos:
        marker = "*" if repo.get("active") else " "
        environment = f" {repo.get('environment')}" if repo.get("environment") else ""
        print(f"{marker} {repo.get('id')}\t{repo.get('name')}\t{repo.get('path')}\t{repo.get('sessionCount')} sessions{environment}")
    return 0


def run_repos_add(parsed: Any) -> int:
    request = build_repo_add_request(parsed)
    confirm_repo_add(parsed, request)
    result = invoke_daemon("runpane:repos:add", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        print_repo_add_result(result)

    return 0


def run_sessions_list(parsed: Any) -> int:
    result = invoke_daemon("runpane:sessions:list", [], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    sessions = result.get("sessions", [])
    if not sessions:
        print("No named Sessions.")
        return 0
    for session in sessions:
        print(
            f"{session.get('id')}\t{session.get('name')}\t{session.get('agent')}\t"
            f"{len(session.get('associations') or [])} Pane(s)"
        )
    return 0


def run_sessions_create(parsed: Any) -> int:
    payload = read_session_payload(parsed, "create")
    result = invoke_daemon("runpane:sessions:create", [payload], pane_dir=parsed.pane_dir)
    return print_session_result(result, parsed.json, "Created")


def run_sessions_get(parsed: Any) -> int:
    result = invoke_daemon("runpane:sessions:get", [_session_selector(parsed)], pane_dir=parsed.pane_dir)
    return print_session_result(result, parsed.json, "")


def run_sessions_update(parsed: Any) -> int:
    payload = read_session_payload(parsed, "update")
    result = invoke_daemon(
        "runpane:sessions:update",
        [{"selector": _session_selector(parsed), "input": payload}],
        pane_dir=parsed.pane_dir,
    )
    return print_session_result(result, parsed.json, "Updated")


def run_sessions_set_agent(parsed: Any) -> int:
    if not parsed.agent:
        raise ValueError("runpane sessions set-agent requires --agent.")
    result = invoke_daemon(
        "runpane:sessions:set-agent",
        [{"selector": _session_selector(parsed), "agent": parsed.agent}],
        pane_dir=parsed.pane_dir,
    )
    return print_session_result(result, parsed.json, "Updated agent for")


def run_sessions_associate(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane sessions associate requires --pane.")
    association: Dict[str, Any] = {"paneId": parsed.pane_id}
    if parsed.panel_id:
        association["panelIds"] = [parsed.panel_id]
    result = invoke_daemon(
        "runpane:sessions:associate",
        [{"selector": _session_selector(parsed), "association": association}],
        pane_dir=parsed.pane_dir,
    )
    return print_session_result(result, parsed.json, "Associated")


def run_sessions_detach(parsed: Any) -> int:
    result = invoke_daemon(
        "runpane:sessions:detach",
        [{"selector": _session_selector(parsed), **optional_value("paneId", parsed.pane_id)}],
        pane_dir=parsed.pane_dir,
    )
    return print_session_result(result, parsed.json, "Detached")


def run_sessions_overview(parsed: Any) -> int:
    result = invoke_daemon("runpane:sessions:overview", [_session_selector(parsed)], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    session = result.get("session") or {}
    print(f"{session.get('name')}: {result.get('status')}")
    for pane in result.get("panes", []):
        if pane.get("missing"):
            details = "missing"
        elif pane.get("archived"):
            details = "archived"
        else:
            details = ", ".join(
                f"{panel.get('title')}={panel.get('state')}"
                for panel in pane.get("panels", [])
            ) or "no terminal panels"
        print(f"  {pane.get('name')}: {details}")
    return 0


def _session_selector(parsed: Any) -> Dict[str, str]:
    session_id = (parsed.session_id or "").strip()
    if not session_id:
        raise ValueError("Named Session id or name is required via --session.")
    return {"sessionId": session_id}


def read_session_payload(parsed: Any, command: str) -> Dict[str, Any]:
    if not parsed.from_json:
        raise ValueError(f"runpane sessions {command} requires --from-json <path|->.")
    try:
        value = json.loads(strip_utf8_bom(read_input_source(parsed.from_json)))
    except json.JSONDecodeError as error:
        raise ValueError(f"runpane sessions {command} received invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"runpane sessions {command} JSON input must be an object.")
    if command == "create" and not isinstance(value.get("name"), str):
        raise ValueError("runpane sessions create JSON input requires a string name.")
    return value


def print_session_result(result: Dict[str, Any], as_json: bool, action: str) -> int:
    if as_json:
        print_json(result)
        return 0 if result.get("ok", result.get("success", False)) else 1
    session = result.get("session") or {}
    if not result.get("ok", result.get("success", False)):
        raise ValueError(result.get("error") or "Sessions operation failed")
    prefix = f"{action} " if action else ""
    print(f"{prefix}Session {session.get('name')} ({session.get('id')})")
    if result.get("panelId"):
        print(f"Panel: {result.get('panelId')}")
    return 0


def run_panes_list(parsed: Any) -> int:
    result = invoke_daemon("runpane:panes:list", [{
        "repo": parsed.repo,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    print_pane_list_result(result)
    return 0


def run_panes_cost(parsed: Any) -> int:
    result = invoke_daemon("runpane:panes:cost", [{
        **optional_value("repo", parsed.repo),
        **optional_value("paneId", parsed.pane_id),
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    print_pane_cost_result(result)
    return 0


def run_workspace_state(parsed: Any) -> int:
    result = invoke_daemon(
        "runpane:workspace:state",
        [{"repo": parsed.repo}],
        pane_dir=parsed.pane_dir,
    )

    if parsed.json:
        print_json(result)
        return 0

    for entry in result.get("entries", []):
        panel = f"\t{entry.get('panelId')}" if entry.get("panelId") else ""
        print(f"{workspace_label(entry.get('kind'))}\t{entry.get('paneName')}{panel}")
    return 0


def has_cadence_value_flag(parsed: Any) -> bool:
    """True when any cadence flag that needs a named daemon cursor was given."""
    return any(value is not None for value in (parsed.settle_ms, parsed.blocked_settle_ms, parsed.min_interval_ms))


def run_watch(parsed: Any) -> int:
    if parsed.watch_as and parsed.watch_since is not None:
        raise ValueError("runpane watch accepts either --as or --since, not both.")

    defaults = RUNPANE_CONTRACT["defaults"]["watch"]
    output_format = parsed.watch_format or ("json" if parsed.json else "lines")
    heartbeat_seconds = parsed.heartbeat_seconds
    if heartbeat_seconds is None:
        heartbeat_seconds = defaults["heartbeatSeconds"] if parsed.follow else 0
    heartbeat_ms = effective_watch_heartbeat_ms(heartbeat_seconds)
    idle_after_ms = parsed.idle_after_ms
    if idle_after_ms is None:
        idle_after_ms = defaults["idleAfterMs"] if parsed.follow else 0
    effective_agents_only = None if parsed.include_shells else (True if parsed.agents_only or parsed.follow else None)
    include_held_input = True if parsed.include_held_input and not parsed.no_held_input else None
    include_held_input_presence = (
        True if defaults["includeHeldInputPresence"]
        and not parsed.no_held_input and parsed.follow and output_format == "lines" else None
    )
    cadence_value_flag_present = has_cadence_value_flag(parsed)
    # Cadence state lives in the daemon per named consumer, so an anonymous follower names itself.
    watch_as = parsed.watch_as
    if watch_as is None and parsed.follow:
        watch_as = os.environ.get("PANE_PANEL_ID") or (f"follow-{os.getpid()}" if cadence_value_flag_present else None)
    request: Dict[str, Any] = {
        **optional_value("as", watch_as),
        **optional_value("since", parsed.watch_since),
        **optional_value("from", parsed.watch_from),
        **optional_value("timeoutMs", parsed.timeout_ms),
        **optional_value("limit", parsed.limit),
        **optional_value("kinds", parsed.watch_kinds or None),
        **optional_value("paneIds", parsed.watch_pane_ids or None),
        **optional_value("excludePaneIds", parsed.watch_exclude_pane_ids or None),
        **optional_value("repo", parsed.repo),
        **optional_value("nameContains", parsed.name_contains),
        **optional_value("agentsOnly", effective_agents_only),
        **optional_value("ackNow", True if parsed.ack_now else None),
        **optional_value("includeHeldInput", include_held_input),
        **optional_value("includeHeldInputPresence", include_held_input_presence),
        "idleAfterMs": idle_after_ms,
        **optional_value("settleMs", parsed.settle_ms),
        **optional_value("blockedSettleMs", parsed.blocked_settle_ms),
        **optional_value("minIntervalMs", parsed.min_interval_ms),
        **optional_value("idleBackoff", True if parsed.idle_backoff else None),
    }

    armed = False
    failing_code: Optional[str] = None
    last_failure_at = 0.0
    last_heartbeat_at = time.monotonic() * 1_000
    anonymous_idle_window_start_ms = 0 if not watch_as and parsed.follow else None
    try:
        while True:
            requested_wait_ms = parsed.timeout_ms if parsed.timeout_ms is not None else (heartbeat_ms or 60_000)
            heartbeat_wait_ms = (
                max(0, heartbeat_ms - (time.monotonic() * 1_000 - last_heartbeat_at))
                if heartbeat_ms > 0 else requested_wait_ms
            )
            timeout_ms = 0 if parsed.self_test else min(requested_wait_ms, heartbeat_wait_ms, 120_000)
            try:
                call_request = dict(request)
                call_request["timeoutMs"] = timeout_ms
                if parsed.self_test:
                    call_request.pop("as", None)
                    call_request.pop("since", None)
                    call_request.update({"from": "now", "idleAfterMs": 0, "timeoutMs": 0})
                elif anonymous_idle_window_start_ms is not None:
                    call_request["idleWindowStartMs"] = anonymous_idle_window_start_ms
                result = invoke_daemon(
                    "runpane:workspace:wait",
                    [call_request],
                    pane_dir=parsed.pane_dir,
                    timeout_ms=timeout_ms + 5_000,
                    event_include=[],
                )
            except PaneDaemonClientError as error:
                if not parsed.follow or error.code not in {
                    "ERR_RUNPANE_DAEMON_CLOSED",
                    "ERR_RUNPANE_DAEMON_CONNECT_FAILED",
                    "ERR_RUNPANE_DAEMON_TIMEOUT",
                    "ECONNREFUSED",
                    "ENOENT",
                }:
                    return emit_watch_failure(error, output_format)
                code = error.code or type(error).__name__
                now_ms = time.monotonic() * 1_000
                if failing_code != code or (heartbeat_ms > 0 and now_ms - last_failure_at >= heartbeat_ms):
                    emit_watch_non_entry("_error", output_format, code=code, message=str(error))
                    last_failure_at = now_ms
                failing_code = code
                time.sleep(1)
                continue
            if failing_code:
                emit_watch_non_entry("_reconnected", output_format, generation=result.get("generation"))
                failing_code = None
            if not armed and (parsed.follow or parsed.self_test):
                emit_watch_non_entry(
                    "_ok",
                    output_format,
                    generation=result.get("generation"),
                    epoch=result.get("epoch"),
                )
                armed = True
                if parsed.self_test:
                    return 0
            print_workspace_wait_result(result, output_format)
            now_ms = time.monotonic() * 1_000
            if heartbeat_ms > 0 and now_ms - last_heartbeat_at >= heartbeat_ms:
                emit_watch_non_entry(
                    "_heartbeat",
                    output_format,
                    generation=result.get("generation"),
                    at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                )
                last_heartbeat_at = now_ms
            if not watch_as:
                request["since"] = result.get("generation")
                if parsed.follow:
                    anonymous_idle_window_start_ms = time.time() * 1_000
            if not parsed.follow:
                break
    except KeyboardInterrupt:
        return 0

    return 0


def effective_watch_heartbeat_ms(seconds: float) -> float:
    configured_ms = seconds * 1_000
    return min(configured_ms, 120_000) if configured_ms > 0 else 0


def run_panes_create(parsed: Any) -> int:
    request = build_pane_create_request(parsed)
    confirm_pane_create(parsed, request)
    result = invoke_daemon(
        "runpane:panes:create",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=(parsed.timeout_ms or 120_000) + (parsed.ready_timeout_ms or 30_000) + 10_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_create_result(result)

    return 0 if result.get("ok") else 1


def run_panes_archive(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panes archive requires --pane.")

    request: Dict[str, Any] = {
        "paneId": parsed.pane_id,
        **optional_value("force", True if parsed.force else None),
        **optional_value("source", parsed.source if parsed.source in ("user", "agent") else None),
        **optional_value("dryRun", True if parsed.dry_run else None),
    }

    confirm_pane_archive(parsed, request)

    result = invoke_daemon(
        "runpane:panes:archive",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=40_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_archive_result(result)

    return 0 if result.get("ok") else 1


def run_panes_pin(parsed: Any, pinned: bool) -> int:
    command = "pin" if pinned else "unpin"
    if not parsed.pane_id:
        raise ValueError(f"runpane panes {command} requires --pane.")

    request = {
        "paneId": parsed.pane_id,
        "pinned": pinned,
        **optional_value("dryRun", True if parsed.dry_run else None),
    }
    confirm_pane_pin(parsed, request)
    result = invoke_daemon(
        "runpane:panes:pin",
        [request],
        pane_dir=parsed.pane_dir,
    )

    if parsed.json:
        print_json(result)
    else:
        print(f"{'Pinned' if result.get('pinned') else 'Unpinned'} {result.get('paneId')}")

    return 0


def run_panes_rename(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panes rename requires --pane.")
    name = parsed.name.strip() if parsed.name else ""
    if not name:
        raise ValueError("runpane panes rename requires a non-empty --name.")

    request = {
        "paneId": parsed.pane_id,
        "name": name,
        **optional_value("dryRun", True if parsed.dry_run else None),
    }
    confirm_pane_rename(parsed, request)
    result = invoke_daemon(
        "runpane:panes:rename",
        [request],
        pane_dir=parsed.pane_dir,
    )

    if parsed.json:
        print_json(result)
    else:
        action = "Would rename" if parsed.dry_run else "Renamed"
        pane = result.get("pane", {})
        print(f"{action} {pane.get('paneId')} to {pane.get('name')}")

    return 0


def run_panes_focus(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panes focus requires --pane.")

    request = {
        "paneId": parsed.pane_id,
        **optional_value("panelId", parsed.panel_id),
        **optional_value("source", parsed.source if parsed.source in ("user", "agent") else None),
    }
    confirm_pane_focus(parsed, request)
    result = invoke_daemon(
        "runpane:panes:focus",
        [request],
        pane_dir=parsed.pane_dir,
    )

    if parsed.json:
        print_json(result)
    else:
        panel_suffix = f" (panel {result.get('panelId')})" if result.get("panelId") else ""
        print(f"Focused {result.get('paneId')}{panel_suffix}")

    return 0


def run_panels_list(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panels list requires --pane.")

    result = invoke_daemon("runpane:panels:list", [{
        "paneId": parsed.pane_id,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    print_panel_list_result(result)
    return 0


def run_panels_create(parsed: Any) -> int:
    request = build_panel_create_request(parsed)
    confirm_panel_create(parsed, request)
    result = invoke_daemon(
        "runpane:panels:create",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=(parsed.ready_timeout_ms or 30_000) + 10_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_panel_create_result(result)
    return 0 if result.get("ok") else 1


def run_panels_output(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels output requires --panel.")

    result = invoke_daemon("runpane:panels:output", [{
        "panelId": parsed.panel_id,
        "limit": parsed.limit,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    text = result.get("text") or ""
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_panels_input(parsed: Any) -> int:
    request = build_panel_input_request(parsed)
    confirm_panel_input(parsed, request)
    result = invoke_daemon("runpane:panels:input", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        input_bytes = result.get("inputBytes", 0)
        suffix = "" if input_bytes == 1 else "s"
        print(f"Sent {input_bytes} byte{suffix} to panel {result.get('panelId')}.")

    return 0


def run_panels_screen(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels screen requires --panel.")

    result = invoke_daemon("runpane:panels:screen", [{
        "panelId": parsed.panel_id,
        "limit": parsed.limit,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    text = result.get("text") or ""
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_panels_submit(parsed: Any) -> int:
    request = build_panel_input_request(parsed, "submit")
    confirm_panel_input(parsed, request, "submit")
    result = invoke_daemon("runpane:panels:submit", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        input_bytes = result.get("inputBytes", 0)
        suffix = "" if input_bytes == 1 else "s"
        verb = "Submitted" if result.get("ok") else "Could not verify"
        verified = " verified" if result.get("verifiedSubmitted") else " unverified"
        print(
            f"{verb} {input_bytes} byte{suffix} via {result.get('sequenceName')} "
            f"to panel {result.get('panelId')}.{verified}"
        )
        if result.get("blocked"):
            print(f"Blocked: {result['blocked'].get('message')}")
        if result.get("nextCommand"):
            print(f"Next: {result.get('nextCommand')}")
    return 0 if result.get("ok") else 1


def run_panels_submit_composer(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels submit-composer requires --panel.")
    confirm_panel_submit_composer(parsed)

    result = invoke_daemon("runpane:panels:submit-composer", [{
        "panelId": parsed.panel_id,
        "strategy": parsed.composer_strategy,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        verb = "Submitted" if result.get("ok") else "Could not verify"
        verified = " verified" if result.get("verifiedSubmitted") else " unverified"
        print(f"{verb} composer with {result.get('sequenceName')} to panel {result.get('panelId')}.{verified}")
        if result.get("blocked"):
            print(f"Blocked: {result['blocked'].get('message')}")
        if result.get("nextCommand"):
            print(f"Next: {result.get('nextCommand')}")
    return 0 if result.get("ok") else 1


def run_panels_wait(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels wait requires --panel.")

    result = invoke_daemon("runpane:panels:wait", [{
        "panelId": parsed.panel_id,
        "condition": parsed.wait_condition,
        "contains": parsed.contains,
        "timeoutMs": parsed.timeout_ms,
        "intervalMs": parsed.interval_ms,
    }], pane_dir=parsed.pane_dir, timeout_ms=(parsed.timeout_ms or 30_000) + 5_000)

    if parsed.json:
        print_json(result)
    else:
        print_panel_wait_result(result)
    return 0 if result.get("ok") else 1


def run_agents_doctor(parsed: Any) -> int:
    if not parsed.agent:
        agents = "|".join(RUNPANE_CONTRACT["enums"]["agents"])
        raise ValueError(f"runpane agents doctor requires --agent {agents}.")

    result = invoke_daemon("runpane:agents:doctor", [{
        "agent": parsed.agent,
        "repo": parsed.repo,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        print_agent_doctor_result(result)
    return 0 if result.get("ok") else 1


def build_repo_add_request(parsed: Any) -> Dict[str, Any]:
    if not parsed.repo_path:
        raise ValueError("runpane repos add requires --path.")

    return {
        "path": parsed.repo_path,
        **optional_value("name", parsed.name),
        **optional_value("dryRun", True if parsed.dry_run else None),
    }


def build_panel_input_request(parsed: Any, command: str = "input") -> Dict[str, Any]:
    if not parsed.panel_id:
        raise ValueError(f"runpane panels {command} requires --panel.")
    if parsed.panel_input is not None and parsed.panel_input_file:
        raise ValueError("Use either --text or --input-file, not both.")
    if parsed.panel_input is None and not parsed.panel_input_file:
        raise ValueError(f"runpane panels {command} requires --text or --input-file.")

    return {
        "panelId": parsed.panel_id,
        "input": read_input_source(parsed.panel_input_file) if parsed.panel_input_file else parsed.panel_input or "",
    }


def build_panel_create_request(parsed: Any) -> Dict[str, Any]:
    if not parsed.pane_id:
        raise ValueError("runpane panels create requires --pane.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    return {
        "paneId": parsed.pane_id,
        "type": "terminal",
        "tool": build_tool_spec(parsed, "panels create"),
        **optional_value("noFocus", True if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)) else None),
        **optional_value("focus", True if parsed.focus else None),
        **optional_value("source", parsed.source),
        **optional_value("waitReady", True if parsed.wait_ready else None),
        **optional_value("readyTimeoutMs", parsed.ready_timeout_ms),
    }


def resolve_pinned_override(parsed: Any) -> Optional[bool]:
    if parsed.pinned and parsed.no_pinned:
        raise ValueError("Use either --pinned or --no-pinned, not both.")
    if parsed.no_pinned:
        return False
    return True if parsed.pinned else None


def build_pane_create_request(parsed: Any) -> Dict[str, Any]:
    if parsed.from_json:
        payload = json.loads(strip_utf8_bom(read_input_source(parsed.from_json)))
        if not isinstance(payload, dict):
            raise ValueError("--from-json payload must be an object.")
        if parsed.dry_run:
            payload["dryRun"] = True
        if parsed.timeout_ms is not None:
            payload["timeoutMs"] = parsed.timeout_ms
        if parsed.wait_ready:
            payload["waitReady"] = True
        if parsed.ready_timeout_ms is not None:
            payload["readyTimeoutMs"] = parsed.ready_timeout_ms
        if parsed.concurrency is not None:
            payload["concurrency"] = parsed.concurrency
        pinned_override = resolve_pinned_override(parsed)
        if pinned_override is not None:
            payload["panes"] = [
                {**item, "pinned": pinned_override} if isinstance(item, dict) else item
                for item in payload.get("panes", [])
            ]
        apply_pane_focus_options(parsed, payload)
        payload.update(optional_value("associateSession", resolve_associate_session(parsed)))
        return payload

    if not parsed.repo:
        raise ValueError("runpane panes create requires --repo unless --from-json is used.")
    if not parsed.name:
        raise ValueError("runpane panes create requires --name unless --from-json is used.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    pinned_override = resolve_pinned_override(parsed)
    pinned = True if pinned_override is None else pinned_override

    return {
        "repo": parsed.repo,
        "panes": [{
            "name": parsed.name,
            **optional_value("worktreeName", parsed.worktree_name),
            **optional_value("baseBranch", parsed.base_branch),
            "pinned": pinned,
            "tool": build_tool_spec(parsed),
        }],
        **optional_value("dryRun", True if parsed.dry_run else None),
        **optional_value("timeoutMs", parsed.timeout_ms),
        **optional_value("waitReady", True if parsed.wait_ready else None),
        **optional_value("readyTimeoutMs", parsed.ready_timeout_ms),
        **optional_value("concurrency", parsed.concurrency),
        **optional_value("noFocus", True if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)) else None),
        **optional_value("focus", True if parsed.focus else None),
        **optional_value("source", parsed.source),
        **optional_value("associateSession", resolve_associate_session(parsed)),
    }


def resolve_associate_session(parsed: Any) -> Optional[str]:
    """Inside a Session orchestrator, new Panes join that Session unless --no-associate."""
    if parsed.no_associate:
        return None
    return (os.environ.get("PANE_ORCHESTRATION_SESSION_ID") or "").strip() or None


def apply_pane_focus_options(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")
    if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)):
        request["noFocus"] = True
    if parsed.focus:
        request["focus"] = True
    if parsed.source:
        request["source"] = parsed.source


def build_tool_spec(parsed: Any, command: str = "panes create") -> Dict[str, Any]:
    if parsed.agent and parsed.tool_command:
        raise ValueError("Use either --agent or --tool-command, not both.")

    initial_input = resolve_initial_input(parsed)
    agent = parsed.agent

    if not agent and not parsed.tool_command:
        if not is_interactive_shell():
            raise ValueError(f"runpane {command} requires --agent or --tool-command in non-interactive shells.")
        agent = ask_agent_choice()

    if agent:
        return {
            "agent": agent,
            **optional_value("title", parsed.title),
            **optional_value("initialInput", initial_input),
        }

    if not parsed.tool_command:
        raise ValueError(f"runpane {command} requires --agent or --tool-command.")

    return {
        "command": parsed.tool_command,
        **optional_value("title", parsed.title),
        **optional_value("initialInput", initial_input),
    }


def resolve_initial_input(parsed: Any) -> Optional[str]:
    if parsed.initial_input and parsed.initial_input_file:
        raise ValueError("Use either --initial-input/--prompt or --initial-input-file, not both.")
    if parsed.initial_input_file:
        return read_input_source(parsed.initial_input_file)
    return parsed.initial_input


def confirm_repo_add(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane repos add mutates Pane state. Rerun with --yes in non-interactive shells.")

    label = f"{request.get('name')} at {request.get('path')}" if request.get("name") else request.get("path")
    answer = input(f"Add Pane repo {label}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_create(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes create mutates Pane state. Rerun with --yes in non-interactive shells.")

    count = len(request.get("panes", []))
    answer = input(f"Create {count} Pane pane{'s' if count != 1 else ''}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_archive(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes archive mutates Pane state. Rerun with --yes in non-interactive shells.")

    suffix = " (including any uncommitted or unpushed work)" if request.get("force") else ""
    answer = input(f"Archive pane {request.get('paneId')}{suffix}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_pin(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    command = "pin" if request.get("pinned") else "unpin"
    if not is_interactive_shell():
        raise ValueError(f"runpane panes {command} mutates Pane state. Rerun with --yes in non-interactive shells.")

    action = "Pin" if request.get("pinned") else "Unpin"
    answer = input(f"{action} pane {request.get('paneId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_rename(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes rename mutates Pane state. Rerun with --yes in non-interactive shells.")

    answer = input(f"Rename pane {request.get('paneId')} to {request.get('name')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_focus(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes focus steals window focus and mutates Pane state. Rerun with --yes in non-interactive shells.")

    panel_suffix = f" (panel {request.get('panelId')})" if request.get("panelId") else ""
    answer = input(f"Focus pane {request.get('paneId')}{panel_suffix}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_create(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panels create mutates Pane state. Rerun with --yes in non-interactive shells.")

    tool = request.get("tool") or {}
    label = tool.get("agent") or tool.get("command")
    answer = input(f"Create a terminal panel for {label} in pane {request.get('paneId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_input(parsed: Any, request: Dict[str, Any], command: str = "input") -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError(f"runpane panels {command} mutates a Pane terminal. Rerun with --yes in non-interactive shells.")

    input_bytes = len(request.get("input", "").encode("utf-8"))
    suffix = "" if input_bytes == 1 else "s"
    verb = "Submit" if command == "submit" else "Send"
    enter_suffix = " plus Enter" if command == "submit" else ""
    answer = input(f"{verb} {input_bytes} byte{suffix}{enter_suffix} to panel {request.get('panelId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_submit_composer(parsed: Any) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panels submit-composer mutates a Pane terminal. Rerun with --yes in non-interactive shells.")

    answer = input(f"Submit composer in panel {parsed.panel_id}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def ask_agent_choice() -> str:
    agents = RUNPANE_CONTRACT["enums"]["agents"]
    print("Choose an agent:")
    for index, agent in enumerate(agents, start=1):
        print(f"{index}) {RUNPANE_CONTRACT['agentTemplates'][agent]['title']}")

    while True:
        answer = input("Agent [1]: ").strip().lower()
        if not answer:
            return agents[0]
        if answer.isdigit() and 1 <= int(answer) <= len(agents):
            return agents[int(answer) - 1]
        if answer in agents:
            return answer
        print(f"Choose one of: {', '.join(agents)}")


def read_input_source(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    with open(source, "r", encoding="utf-8") as handle:
        return handle.read()


def strip_utf8_bom(value: str) -> str:
    return value.lstrip("\ufeff")


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))


def sanitize_watch_value(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", str(value))).strip() or "<unnamed>"


def print_workspace_wait_result(result: Dict[str, Any], output_format: str) -> None:
    reset = result.get("reset")
    if reset:
        if output_format == "json":
            print(json.dumps({
                "kind": "_reset",
                "reason": reset.get("reason"),
                "epoch": result.get("epoch"),
            }, separators=(",", ":")), flush=True)
        else:
            print(f"RESET {sanitize_watch_value(reset.get('reason'))} epoch {sanitize_watch_value(result.get('epoch'))}", flush=True)

    if result.get("dropped") is not None:
        if output_format == "json":
            print(json.dumps({"kind": "_dropped", "count": result.get("dropped")}, separators=(",", ":")), flush=True)
        else:
            print(f"DROPPED {result.get('dropped')}", flush=True)

    for entry in result.get("entries", []):
        if output_format == "json":
            print(json.dumps(entry, separators=(",", ":")), flush=True)
            continue
        line = format_workspace_entry_line(entry)
        if line:
            print(line, flush=True)
        if entry.get("kind") in {"agent.ready", "agent.idle"} and (entry.get("heldInputPresent") or entry.get("heldInput")):
            panel = f" panel {sanitize_watch_value(entry.get('panelId'))}" if entry.get("panelId") else ""
            print(
                f"STUCK {sanitize_watch_value(entry.get('paneName'))} pane {sanitize_watch_value(entry.get('paneId'))}{panel} held-input-present",
                flush=True,
            )


def format_workspace_entry_line(entry: Dict[str, Any]) -> Optional[str]:
    if entry.get("baseline") and not entry.get("changedWhileAway"):
        return None
    name = sanitize_watch_value(entry.get("paneName"))
    pane = f"pane {sanitize_watch_value(entry.get('paneId'))}"
    panel = f" panel {sanitize_watch_value(entry.get('panelId'))}" if entry.get("panelId") else ""
    if entry.get("changedWhileAway"):
        return f"CHANGED {name} {pane}{panel}"
    kind = entry.get("kind")
    if kind == "agent.idle":
        minutes = max(0, int(entry.get("idleMs") or 0) // 60_000)
        return f"IDLE {name} {minutes}m {pane}{panel}"
    if kind == "panel.exited":
        code = entry.get("exitCode") if entry.get("exitCode") is not None else "unknown"
        return f"EXIT {name} {pane}{panel} code {code}"
    if kind in {"pane.created", "pane.gone"}:
        return f"{workspace_label(kind)} {name} {pane}"
    return f"{workspace_label(kind)} {name} {pane}{panel}"


def emit_watch_non_entry(kind: str, output_format: str, **fields: Any) -> None:
    if output_format == "json":
        print(json.dumps({"kind": kind, **fields}, separators=(",", ":")), flush=True)
        return
    if kind == "_ok":
        print(f"WATCH OK gen {fields.get('generation')} epoch {sanitize_watch_value(fields.get('epoch'))}", flush=True)
    elif kind == "_heartbeat":
        print(f"HEARTBEAT gen {fields.get('generation')} at {fields.get('at')}", flush=True)
    elif kind == "_reconnected":
        print(f"WATCH RECONNECTED gen {fields.get('generation')}", flush=True)
    else:
        print(f"WATCH ERROR {sanitize_watch_value(fields.get('code'))}: {sanitize_watch_value(fields.get('message'))}", flush=True)


def emit_watch_failure(error: Exception, output_format: str) -> int:
    code = error.code if isinstance(error, PaneDaemonClientError) and error.code else type(error).__name__
    if output_format == "json":
        line = json.dumps({"kind": "_error", "code": code, "message": str(error)}, separators=(",", ":"))
    else:
        line = f"WATCH ERROR {sanitize_watch_value(code)}: {sanitize_watch_value(error)}"
    print(line, flush=True)
    print(line, file=sys.stderr, flush=True)
    return 2


def workspace_label(kind: Any) -> str:
    return {
        "agent.ready": "READY",
        "agent.busy": "BUSY",
        "agent.blocked": "BLOCKED",
        "agent.unknown": "UNKNOWN",
        "agent.idle": "IDLE",
        "pane.created": "NEW",
        "pane.gone": "GONE",
        "panel.exited": "EXIT",
    }.get(kind, str(kind).upper())


def print_repo_add_result(result: Dict[str, Any]) -> None:
    preview = result.get("preview") or {}
    if result.get("dryRun") and preview:
        if preview.get("alreadyExists"):
            print(f"Repo already exists: {preview.get('name')}\t{preview.get('path')}")
            return
        print(f"Would add Pane repo {preview.get('name')}\t{preview.get('path')}")
        return

    repo = result.get("repo")
    if repo:
        action = "Added Pane repo" if result.get("created") else "Repo already exists"
        print(f"{action}: {repo.get('id')}\t{repo.get('name')}\t{repo.get('path')}")
        return

    print("Repo add completed.")


def print_pane_list_result(result: Dict[str, Any]) -> None:
    panes = result.get("panes", [])
    if not panes:
        print("No Pane sessions found.")
        return

    for pane in panes:
        repo = f" {pane.get('repoName')}" if pane.get("repoName") else ""
        pinned = " pinned" if pane.get("pinned") else ""
        print(f"{pane.get('id')}\t{pane.get('name')}\t{pane.get('status')}{pinned}\t{pane.get('panelCount')} panels\t{pane.get('worktreePath')}{repo}")


def print_pane_cost_result(result: Dict[str, Any]) -> None:
    for pane in result.get("panes", []):
        hit_rate = int(pane.get("cacheHitRate", 0) * 100 + 0.5)
        uncached_cost = format_pane_cost(pane.get("uncachedCostUsd", 0), pane.get("costIncomplete", False))
        total_cost = format_pane_cost(pane.get("estimatedCostUsd", 0), pane.get("costIncomplete", False))
        print(f"{pane.get('paneId')}\t{pane.get('paneName')}\t{uncached_cost} uncached\t{total_cost} total\t{hit_rate}% hit")
        print_pane_cost_models(pane.get("byModel", []))
    unattributed = result.get("unattributed")
    if unattributed:
        hit_rate = int(unattributed.get("cacheHitRate", 0) * 100 + 0.5)
        uncached_cost = format_pane_cost(unattributed.get("uncachedCostUsd", 0), unattributed.get("costIncomplete", False))
        total_cost = format_pane_cost(unattributed.get("estimatedCostUsd", 0), unattributed.get("costIncomplete", False))
        print(f"Unattributed\t{uncached_cost} uncached\t{total_cost} total\t{hit_rate}% hit")
        print_pane_cost_models(unattributed.get("byModel", []))
    totals = result.get("totals")
    if totals:
        total_cost = format_pane_cost(totals.get("estimatedCostUsd", 0), totals.get("costIncomplete", False))
        print(f"Total\t{total_cost}\t{totals.get('totalTokens', 0)} tokens")


def format_pane_cost(cost_usd: float, cost_incomplete: bool) -> str:
    return "n/a" if cost_incomplete else f"${cost_usd:.4f}"


def print_pane_cost_models(models: list[Dict[str, Any]]) -> None:
    for model in models:
        cost = "n/a" if model.get("costIncomplete") else f"${model.get('estimatedCostUsd', 0):.4f}"
        print(f"  {model.get('model')}\t{model.get('totalTokens', 0)} tokens\t{cost}")


def print_pane_create_result(result: Dict[str, Any]) -> None:
    for item in result.get("items", []):
        name = item.get("name") or f"pane {item.get('index')}"
        if item.get("ok"):
            worktree = f" at {item.get('worktreePath')}" if item.get("worktreePath") else ""
            print(f"Created {name}: session {item.get('sessionId', 'unknown')} panel {item.get('panelId', 'unknown')}{worktree}")
            readiness = item.get("readiness")
            if readiness:
                ready_state = "yes" if readiness.get("ok") else "timed out" if readiness.get("timedOut") else "blocked"
                print(f"  Ready: {ready_state} after {readiness.get('elapsedMs')}ms")
                blocked = readiness.get("blocked")
                if blocked:
                    print(f"  Blocked: {blocked.get('message')}")
            association = item.get("association")
            if association:
                if association.get("ok"):
                    print(f"  Associated with Session {association.get('sessionId')}")
                else:
                    print(f"  Not associated with Session {association.get('sessionId')}: {association.get('error', 'unknown error')}")
            if item.get("nextCommand"):
                print(f"  Next: {item.get('nextCommand')}")
        else:
            error = item.get("error") or {}
            print(f"Failed {name}: {error.get('message', 'unknown error')}", file=sys.stderr)


def print_pane_archive_result(result: Dict[str, Any]) -> None:
    if result.get("dryRun"):
        action = "Would archive" if result.get("wouldArchive") else "Would refuse to archive"
        forced = " (forced)" if result.get("forced") else ""
        print(f"{action} pane {result.get('paneId')}{forced}.")
        blocked = result.get("blocked") or {}
        if blocked:
            print(f"Safety: {blocked.get('message')}")
        print_archive_commit_evidence(result.get("safetyCheck") or {})
        return

    if "archived" not in result:
        blocked = result.get("blocked") or {}
        print(f"Refused to archive pane {result.get('paneId')}: {blocked.get('message')}", file=sys.stderr)
        print_archive_commit_evidence(blocked.get("safetyCheck") or {}, file=sys.stderr)
        print(f"Next: {result.get('nextCommand')}", file=sys.stderr)
        return

    forced = " (forced)" if result.get("forced") else ""
    print(f"Archived pane {result.get('paneId')}{forced}. Worktree cleanup: {result.get('worktreeCleanup')}.")


def print_archive_commit_evidence(safety_check: Dict[str, Any], file: Any = None) -> None:
    destination = file if file is not None else sys.stdout
    upstream = safety_check.get("upstream")
    if upstream:
        refreshed = " (refreshed)" if safety_check.get("upstreamRefreshed") else ""
        print(f"Upstream: {upstream}{refreshed}", file=destination)
    for commit in safety_check.get("unpushedCommitDetails") or []:
        print(f"Unpushed: {commit.get('sha')} {commit.get('subject')}", file=destination)


def print_panel_create_result(result: Dict[str, Any]) -> None:
    active = " active" if result.get("active") else " background"
    print(f"Created panel {result.get('panelId')} in pane {result.get('paneId')}: {result.get('title')}{active}")
    readiness = result.get("readiness")
    if readiness:
        ready_state = "yes" if readiness.get("ok") else "timed out" if readiness.get("timedOut") else "blocked"
        print(f"Ready: {ready_state} after {readiness.get('elapsedMs')}ms")
        blocked = readiness.get("blocked")
        if blocked:
            print(f"Blocked: {blocked.get('message')}")
    if result.get("nextCommand"):
        print(f"Next: {result.get('nextCommand')}")


def print_panel_wait_result(result: Dict[str, Any]) -> None:
    condition = result.get("condition")
    panel_id = result.get("panelId")
    elapsed = result.get("elapsedMs")
    if result.get("ok"):
        print(f"Matched {condition} for panel {panel_id} after {elapsed}ms.")
    elif result.get("blocked"):
        print(f"Blocked waiting for {condition} on panel {panel_id}: {result['blocked'].get('message')}")
    elif result.get("timedOut"):
        print(f"Timed out waiting for {condition} on panel {panel_id} after {elapsed}ms.")
    else:
        print(f"Did not match {condition} for panel {panel_id}.")

    state = result.get("state") or {}
    status_parts = [
        "initialized" if state.get("initialized") else "not-initialized",
        state.get("activityStatus"),
        None if state.get("isCliReady") is None else "cli-ready" if state.get("isCliReady") else "cli-not-ready",
        state.get("agentType"),
    ]
    status = ", ".join(part for part in status_parts if part)
    if status:
        print(f"State: {status}")
    if result.get("nextCommand"):
        print(f"Next: {result.get('nextCommand')}")


def print_agent_doctor_result(result: Dict[str, Any]) -> None:
    repo = f" in {result['repo'].get('name')}" if result.get("repo") else ""
    environment = f" ({result.get('environment')})" if result.get("environment") else ""
    print(f"{result.get('agent')}: {'available' if result.get('available') else 'not available'}{repo}{environment}")
    if result.get("executablePath"):
        print(f"Path: {result.get('executablePath')}")
    if result.get("version"):
        print(f"Version: {result.get('version')}")
    for check in result.get("checks", []):
        print(f"{'OK' if check.get('ok') else 'FAIL'} {check.get('name')}: {check.get('message')}")
    for warning in result.get("warnings") or []:
        print(f"Warning: {warning}")


def print_panel_list_result(result: Dict[str, Any]) -> None:
    panels = result.get("panels", [])
    pane_id = result.get("paneId")
    if not panels:
        print(f"No panels found for pane {pane_id}.")
        return

    for panel in panels:
        marker = "*" if panel.get("active") else " "
        initialized = ""
        if panel.get("initialized") is not None:
            initialized = " initialized" if panel.get("initialized") else " not-initialized"
        agent = f" {panel.get('agentType')}" if panel.get("agentType") else ""
        print(f"{marker} {panel.get('id')}\t{panel.get('type')}\t{panel.get('title')}{initialized}{agent}")


def optional_value(key: str, value: Any) -> Dict[str, Any]:
    return {key: value} if value is not None else {}


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))
