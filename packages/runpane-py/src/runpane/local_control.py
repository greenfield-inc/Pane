from __future__ import annotations

import hashlib
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
        report = pane.get("report")
        if report:
            print(f"    report {describe_report(report)} (panel {report.get('panelId')}, {report.get('reportedAt')})")
    for lock in result.get("locks") or []:
        print(f"  lock {format_lock_line(lock)}")
    return 0


# One daemon call waits at most this long; longer waits chain calls, each blocking in the daemon.
LOCK_WAIT_PER_CALL_MS = 120_000


def run_lock_acquire(parsed: Any) -> int:
    name = _require_lock_name(parsed, "acquire")
    if parsed.lock_ttl_ms is None:
        raise ValueError("runpane lock acquire requires --ttl <duration>, such as --ttl 30m.")
    request: Dict[str, Any] = {
        "name": name,
        "ttlMs": parsed.lock_ttl_ms,
        **optional_value("note", parsed.note),
        "owner": _lock_owner(parsed, False),
    }
    wait_ms = parsed.lock_wait_ms or 0
    started_at = time.monotonic()
    while True:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        call_wait_ms = min(max(0, wait_ms - elapsed_ms), LOCK_WAIT_PER_CALL_MS)
        result = invoke_daemon(
            "runpane:locks:acquire",
            [{**request, "waitMs": call_wait_ms}],
            pane_dir=parsed.pane_dir,
            timeout_ms=call_wait_ms + 15_000,
        )
        # Only a call that waited out its whole window without the lock coming free chains another.
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        if result.get("ok") or not result.get("timedOut") or elapsed_ms >= wait_ms:
            break
    result = {**result, "waitedMs": int((time.monotonic() - started_at) * 1000)}
    if parsed.json:
        print_json(result)
    elif result.get("ok"):
        action = "Renewed" if result.get("renewed") else "Acquired"
        print(f"{action} lock {format_lock_line(result.get('lock') or {})}")
    else:
        lock = result.get("lock") or {}
        note = f" ({lock.get('note')})" if lock.get("note") else ""
        print(f"Lock {lock.get('name')} is held by {format_lock_owner(result.get('heldBy') or {})} until {result.get('expiresAt')}{note}.")
    return 0 if result.get("ok") else 1


def run_lock_release(parsed: Any) -> int:
    name = _require_lock_name(parsed, "release")
    request: Dict[str, Any] = {
        "name": name,
        **optional_value("force", True if parsed.force else None),
        **optional_value("sessionId", (parsed.session_id or "").strip() or None),
        "owner": _lock_owner(parsed, bool(parsed.force)),
    }
    result = invoke_daemon("runpane:locks:release", [request], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
    elif not result.get("ok"):
        print(
            f"Lock {name} is held by {format_lock_owner(result.get('heldBy') or {})} until {result.get('expiresAt')}; "
            "only its owner can release it. Rerun with --force to release it anyway."
        )
    elif result.get("released"):
        print(f"{'Force-released' if result.get('forced') else 'Released'} lock {name}.")
    else:
        print(f"Lock {name} was not held.")
    return 0 if result.get("ok") else 1


def run_lock_list(parsed: Any) -> int:
    request = optional_value("sessionId", (parsed.session_id or "").strip() or None)
    result = invoke_daemon("runpane:locks:list", [request], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    locks = result.get("locks") or []
    for lock in locks:
        print(format_lock_line(lock))
    if not locks:
        print("No locks held.")
    return 0


def run_cloud_safe_to_stop(parsed: Any) -> int:
    if parsed.force and parsed.dry_run:
        raise ValueError("runpane cloud safe-to-stop takes --force or --dry-run, not both.")
    flush = "always" if parsed.force else "never" if parsed.dry_run else "if-safe"
    result = invoke_daemon("runpane:cloud:safe-to-stop", [{"flush": flush}], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
    else:
        print("Safe to stop." if result.get("safe") else "Not safe to stop:")
        for blocker in result.get("blockers") or []:
            print(f"  {blocker.get('condition')}: {blocker.get('message')}")
    # 3 = blocked, so scripts can tell it from a failure (1).
    return 0 if result.get("safe") else 3


def _require_lock_name(parsed: Any, action: str) -> str:
    name = (parsed.name or "").strip()
    if not name:
        raise ValueError(f"runpane lock {action} requires --name <name>.")
    return name


def _lock_owner(parsed: Any, forced: bool) -> Dict[str, Any]:
    """The caller owns the lock: --pane/--panel, else $PANE_SESSION_ID/$PANE_PANEL_ID; outside Pane, --note."""
    explicit = bool(parsed.pane_id or parsed.panel_id)
    pane_id = parsed.pane_id if explicit else (os.environ.get("PANE_SESSION_ID") or "").strip() or None
    panel_id = parsed.panel_id if explicit else (os.environ.get("PANE_PANEL_ID") or "").strip() or None
    if pane_id or panel_id:
        return {**optional_value("paneId", pane_id), **optional_value("panelId", panel_id)}
    label = (parsed.note or "").strip()
    if not label and not forced:
        raise ValueError(
            "Outside a Pane terminal, pass --note <text> to say who holds the lock "
            "(or --pane/--panel to act for a Pane)."
        )
    return optional_value("label", label or None)


def format_lock_owner(owner: Dict[str, Any]) -> str:
    if owner.get("kind") == "external":
        return f'external "{owner.get("label") or ""}"'
    if owner.get("panelId"):
        return f"pane {owner.get('paneId')} panel {owner.get('panelId')}"
    return f"pane {owner.get('paneId')}"


def format_lock_line(lock: Dict[str, Any]) -> str:
    scope = f"session {lock.get('sessionId')}" if lock.get("scope") == "session" else "global"
    note = f" ({lock.get('note')})" if lock.get("note") else ""
    return (
        f"{lock.get('name')} [{scope}] held by {format_lock_owner(lock.get('owner') or {})} "
        f"until {lock.get('expiresAt')}{note}"
    )


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
    # Lines mode turns presence into STUCK; JSON mode passes heldInputPresent through as the equivalent.
    include_held_input_presence = (
        True if defaults["includeHeldInputPresence"]
        and not parsed.no_held_input and parsed.follow else None
    )
    cadence_value_flag_present = has_cadence_value_flag(parsed)
    # Cadence state lives in the daemon per named consumer, so an anonymous follower names itself.
    # A Session watch is named after the Session, so it survives an orchestrator agent switch.
    watch_as = parsed.watch_as
    if watch_as is None and parsed.follow:
        session_cursor = session_watch_cursor_name(parsed.session_id) if parsed.session_id else None
        panel_id = os.environ.get("PANE_PANEL_ID")
        panel_cursor = derived_watch_cursor_name("panel", panel_id) if panel_id else None
        watch_as = session_cursor or panel_cursor or (f"follow-{os.getpid()}" if cadence_value_flag_present else None)
    # --quiet drops lines that only prove liveness; --self-test still prints its WATCH OK result.
    quiet = bool(parsed.quiet)
    request: Dict[str, Any] = {
        **optional_value("as", watch_as),
        **optional_value("since", parsed.watch_since),
        **optional_value("from", parsed.watch_from),
        **optional_value("timeoutMs", parsed.timeout_ms),
        **optional_value("limit", parsed.limit),
        **optional_value("kinds", parsed.watch_kinds or None),
        **optional_value("paneIds", parsed.watch_pane_ids or None),
        # The daemon resolves the Session (id or exact name) and re-reads its Panes on every read.
        **optional_value("session", parsed.session_id),
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
            if request.get("session") and not result.get("session"):
                # An older daemon ignores the unknown field and would watch every Pane instead.
                return emit_watch_failure(
                    RuntimeError(
                        "This Pane daemon does not support runpane watch --session; "
                        "update Pane, or pass one --pane per Session Pane."
                    ),
                    output_format,
                )
            if failing_code:
                if not quiet:
                    emit_watch_non_entry("_reconnected", output_format, generation=result.get("generation"))
                failing_code = None
            if not armed and (parsed.follow or parsed.self_test):
                if parsed.self_test or not quiet:
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
                if not quiet:
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


# Names older daemons accept; the daemon itself allows up to 128 characters.
PORTABLE_WATCH_CURSOR_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")


def derived_watch_cursor_name(prefix: str, name: str) -> str:
    """Return a derived watch cursor name (built from an ID, not typed by the user) that every daemon accepts.

    A name that is too long or has other characters becomes `<prefix>-<first 12 hex chars of its sha256>`.
    """
    if PORTABLE_WATCH_CURSOR_PATTERN.fullmatch(name):
        return name
    return f"{prefix}-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:12]}"


def session_watch_cursor_name(session: str) -> str:
    """Default cursor for `watch --session`: `session-<uuid>` for a Session id, `session-<name>` for a name.

    Shortened like any derived name when it is longer than 64 characters or has other characters.
    """
    match = re.fullmatch(r"__orchestration_session_(.+)__", session)
    return derived_watch_cursor_name("session", f"session-{match.group(1) if match else session}")


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
    if parsed.session_id:
        return run_panes_archive_session(parsed, parsed.session_id)
    if not parsed.pane_id:
        raise ValueError("runpane panes archive requires --pane (or --session with --merged).")

    request: Dict[str, Any] = {
        "paneId": parsed.pane_id,
        **optional_value("force", True if parsed.force else None),
        **optional_value("source", parsed.source if parsed.source in ("user", "agent") else None),
        **optional_value("dryRun", True if parsed.dry_run else None),
        **optional_value("removeWorktree", True if parsed.remove_worktree else None),
    }

    suffix = " (including any uncommitted or unpushed work)" if request.get("force") else ""
    confirm_pane_archive(parsed, f"Archive pane {request.get('paneId')}{suffix}")

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


def run_panes_archive_session(parsed: Any, session_id: str) -> int:
    if not parsed.merged:
        raise ValueError("runpane panes archive --session requires --merged.")
    request: Dict[str, Any] = {
        "sessionId": session_id,
        "merged": True,
        **optional_value("source", parsed.source if parsed.source in ("user", "agent") else None),
        **optional_value("dryRun", True if parsed.dry_run else None),
        **optional_value("removeWorktree", True if parsed.remove_worktree else None),
    }

    confirm_pane_archive(parsed, f"Archive every merged or pushed Pane in Session {session_id}")

    result = invoke_daemon(
        "runpane:panes:archive",
        [request],
        pane_dir=parsed.pane_dir,
        # Each Pane refreshes its upstream and may wait for its worktree removal.
        timeout_ms=600_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_archive_bulk_result(result)

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


def run_panels_open(parsed: Any) -> int:
    pane_id = parsed.pane_id or os.environ.get("PANE_SESSION_ID")
    if not pane_id:
        raise ValueError("runpane panels open requires --pane (or PANE_SESSION_ID from a Pane terminal).")
    if bool(parsed.url) == bool(parsed.file):
        raise ValueError("runpane panels open requires exactly one of --url or --file.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    request = {
        "paneId": pane_id,
        **optional_value("url", parsed.url),
        **optional_value("filePath", parsed.file),
        **optional_value("title", parsed.title),
        "placement": parsed.placement or "split",
        **optional_value("noFocus", True if parsed.no_focus else None),
        **optional_value("focus", True if parsed.focus else None),
        **optional_value("source", parsed.source if parsed.source in ("user", "agent") else None),
    }
    confirm_panel_open(parsed, request)
    result = invoke_daemon("runpane:panels:open", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        target = result.get("url") or result.get("filePath") or result.get("title")
        action = "Reused" if result.get("reused") else "Opened"
        print(f"{action} {result.get('type')} panel {result.get('panelId')} in pane {result.get('paneId')} ({result.get('placement')}): {target}")
    return 0


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

    text = mark_suggestion_line(result.get("text") or "", (result.get("composer") or {}).get("ghostText"))
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_panels_last_message(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels last-message requires --panel.")

    result = invoke_daemon("runpane:panels:last-message", [{
        "panelId": parsed.panel_id,
        "limit": parsed.limit,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    elif result.get("ok"):
        text = result.get("text") or ""
        sys.stdout.write(text)
        if text and not text.endswith("\n"):
            sys.stdout.write("\n")
        if result.get("truncated"):
            print(f"(showing the last {result.get('limit')} of {result.get('length')} characters)", file=sys.stderr)
    else:
        print(f"{result.get('reason')}: {result.get('message')}", file=sys.stderr)
    return 0 if result.get("ok") else 1


def resolve_report_identity(parsed: Any, env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Where a report is for: explicit --panel (with an optional --pane), else the Pane terminal's own panel."""
    env = os.environ if env is None else env
    if parsed.pane_id or parsed.panel_id:
        if not parsed.panel_id:
            raise ValueError("runpane report --pane also needs --panel <panel-id>. Find it with `runpane panels list --pane <pane-id>`.")
        return {"paneId": parsed.pane_id, "panelId": parsed.panel_id} if parsed.pane_id else {"panelId": parsed.panel_id}
    panel_id = (env.get("PANE_PANEL_ID") or "").strip()
    if not panel_id:
        raise ValueError(
            "runpane report cannot tell which panel is reporting. Run it inside a Pane terminal "
            "(which sets PANE_SESSION_ID and PANE_PANEL_ID), or pass --pane <pane-id> --panel <panel-id>."
        )
    pane_id = (env.get("PANE_SESSION_ID") or "").strip()
    return {"paneId": pane_id, "panelId": panel_id} if pane_id else {"panelId": panel_id}


# The CLIs send one character past the daemon's 16,000 so it still marks an overlong summary truncated.
MAX_SENT_SUMMARY_LENGTH = 16_001


def run_report(parsed: Any, env: Optional[Dict[str, str]] = None) -> int:
    identity = resolve_report_identity(parsed, env)
    summary = strip_utf8_bom(read_input_source(parsed.summary_file)) if parsed.summary_file is not None else parsed.summary
    summary_path = os.path.abspath(parsed.summary_file) if parsed.summary_file not in (None, "-") else None
    request: Dict[str, Any] = {
        **identity,
        "state": parsed.report_state,
        **optional_value("pr", parsed.report_pr),
        **optional_value("head", parsed.report_head),
        **optional_value("summary", summary[:MAX_SENT_SUMMARY_LENGTH] if summary is not None else None),
        **optional_value("summaryPath", summary_path),
        **optional_value("question", parsed.question),
    }
    result = invoke_daemon("runpane:report", [request], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
    else:
        session_ids = result.get("sessionIds") or []
        sessions = f" Recorded on Session {', '.join(session_ids)}." if session_ids else ""
        print(f"Reported {describe_report(result.get('report') or {})} for panel {result.get('panelId')}.{sessions}")
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
        print_delivery(result.get("delivery"))
        if result.get("deduplicated"):
            print("This idempotency key was already used; Pane returned the first result and sent nothing again.")
        if result.get("blocked"):
            print(f"Blocked: {result['blocked'].get('message')}")
        print_prompt_notes(result)
        if result.get("nextCommand"):
            print(f"Next: {result.get('nextCommand')}")
    return 0 if result.get("ok") else 1


def print_delivery(delivery: Optional[Dict[str, Any]], prefix: str = "") -> None:
    """Where the prompt went, for human output: `Delivery: queued (transcript)`."""
    if delivery:
        print(f"{prefix}Delivery: {delivery.get('state')} ({delivery.get('evidence')})")


def mark_suggestion_line(text: str, ghost_text: Optional[str]) -> str:
    """Mark the composer line that shows ghost text (a placeholder or suggested prompt)."""
    ghost = (ghost_text or "").split("\n")[0].strip()
    if not ghost:
        return text
    lines = text.split("\n")
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index].strip()
        if line[:1] in ("❯", "›", ">") and ghost in line:
            lines[index] = f"{lines[index].rstrip()}  ⟨suggestion⟩"
            break
    return "\n".join(lines)


def print_prompt_notes(result: Dict[str, Any], prefix: str = "") -> None:
    """The prompt file Pane wrote and any leading-character warnings, for human output."""
    if result.get("promptFile"):
        print(f"{prefix}Prompt file: {result.get('promptFile')}")
    for warning in result.get("warnings") or []:
        print(f"{prefix}Warning ({warning.get('code')}): {warning.get('message')}")


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
        print_delivery(result.get("delivery"))
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
    sources = sum([parsed.panel_input is not None, bool(parsed.panel_input_file), parsed.keys is not None])
    if sources > 1:
        raise ValueError("Use only one of --text, --keys, or --input-file.")
    if sources == 0:
        raise ValueError(f"runpane panels {command} requires --text, --keys, or --input-file.")
    if parsed.keys is not None and command != "input":
        raise ValueError("--keys is for panels input; panels submit sends text followed by Enter.")
    if parsed.as_file_pointer and command != "submit":
        raise ValueError("--as-file-pointer is for panels submit; panels input sends exact bytes.")
    if parsed.idempotency_key is not None and command != "submit":
        raise ValueError("--idempotency-key is for panels submit.")

    if parsed.keys is not None:
        text = keys_to_bytes(parsed.keys)
    elif parsed.panel_input_file:
        text = read_input_source(parsed.panel_input_file)
    else:
        text = parsed.panel_input or ""
    return {
        "panelId": parsed.panel_id,
        "input": text,
        **optional_value("asFilePointer", True if parsed.as_file_pointer else None),
        **optional_value("idempotencyKey", parsed.idempotency_key),
    }


def keys_to_bytes(keys: Any) -> str:
    named = RUNPANE_CONTRACT["terminalKeys"]
    out = []
    for key in keys:
        value = named.get(key.lower(), key if len(key) == 1 else None)
        if value is None:
            raise ValueError(f'Unknown key "{key}". Use {", ".join(named)}, or a single character.')
        out.append(value)
    return "".join(out)


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
        payload["panes"] = [
            {**item, "pinned": pinned_override if pinned_override is not None else item.get("pinned", not bool(os.environ.get("PANE_ORCHESTRATION_SESSION_ID")))}
            if isinstance(item, dict) else item
            for item in payload.get("panes", [])
        ]
        apply_pane_focus_options(parsed, payload)
        if parsed.no_associate:
            payload.pop("associateSession", None)
        else:
            payload.update(optional_value("associateSession", resolve_associate_session(parsed)))
        return payload

    if not parsed.repo:
        raise ValueError("runpane panes create requires --repo unless --from-json is used.")
    if not parsed.name:
        raise ValueError("runpane panes create requires --name unless --from-json is used.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    pinned_override = resolve_pinned_override(parsed)
    pinned = not bool(os.environ.get("PANE_ORCHESTRATION_SESSION_ID")) if pinned_override is None else pinned_override

    return {
        "repo": parsed.repo,
        "panes": [{
            "name": parsed.name,
            **optional_value("worktreeName", parsed.worktree_name),
            **optional_value("branch", parsed.branch),
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
    initial_input = resolve_initial_input(parsed)
    if parsed.as_file_pointer and initial_input is None:
        raise ValueError(f"--as-file-pointer needs a prompt: pass --prompt or --initial-input-file to runpane {command}.")
    file_pointer = optional_value("initialInputAsFilePointer", True if parsed.as_file_pointer else None)

    # With --tool-command, --agent names the agent the command runs (a wrapper
    # such as `agent-farm run`); Pane launches the command unchanged.
    if parsed.tool_command and parsed.agent:
        return {
            "command": parsed.tool_command,
            "agentType": parsed.agent,
            **optional_value("title", parsed.title),
            **optional_value("initialInput", initial_input),
            **file_pointer,
        }
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
            **file_pointer,
        }

    if not parsed.tool_command:
        raise ValueError(f"runpane {command} requires --agent or --tool-command.")

    return {
        "command": parsed.tool_command,
        **optional_value("title", parsed.title),
        **optional_value("initialInput", initial_input),
        **file_pointer,
    }


def resolve_initial_input(parsed: Any) -> Optional[str]:
    if parsed.initial_input and parsed.initial_input_file:
        raise ValueError("Use either --initial-input/--prompt or --initial-input-file/--prompt-file, not both.")
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


def confirm_pane_archive(parsed: Any, question: str) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes archive mutates Pane state. Rerun with --yes in non-interactive shells.")

    answer = input(f"{question}? [y/N] ").strip().lower()
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


def confirm_panel_open(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panels open mutates Pane state. Rerun with --yes in non-interactive shells.")

    target = request.get("url") or request.get("filePath")
    answer = input(f"Open {target} in pane {request.get('paneId')}? [y/N] ").strip().lower()
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
    if kind in {"pane.associated", "pane.detached"}:
        return f"{workspace_label(kind)} {name} {pane} session {sanitize_watch_value(entry.get('sessionId') or '')}"
    if kind in {"pr.conflicted", "pr.checks", "pr.merged"}:
        return format_pr_entry_line(kind, f"PR {name} {pane} #{(entry.get('pr') or {}).get('number', '?')}", entry)
    if kind == "agent.report":
        report = entry.get("report")
        return f"REPORT {name} {pane}{panel} {describe_report(report) if report else 'unknown'}"
    return f"{workspace_label(kind)} {name} {pane}{panel}"


def format_pr_entry_line(kind: str, prefix: str, entry: Dict[str, Any]) -> str:
    if kind == "pr.conflicted":
        return f"{prefix} CONFLICTED"
    if kind == "pr.merged":
        return f"{prefix} MERGED"
    if entry.get("checks") != "failed":
        return f"{prefix} CHECKS PASSED"
    # Failing names are joined by commas, so their own spaces and commas become underscores.
    names = [re.sub(r"[ ,]", "_", sanitize_watch_value(check)) for check in entry.get("failingChecks") or []]
    return f"{prefix} CHECKS FAILED" + (f" {','.join(names)}" if names else "")


MAX_LINE_QUESTION_LENGTH = 200


def describe_report(report: Dict[str, Any]) -> str:
    """`ready pr#747 fc5dce9`, or `blocked pr#747: <question>` cut to 200 characters."""
    parts = [sanitize_watch_value(report.get("state"))]
    if report.get("pr") is not None:
        parts.append(f"pr#{report.get('pr')}")
    if report.get("head"):
        parts.append(sanitize_watch_value(report.get("head"))[:7])
    question = sanitize_watch_value(report.get("question")) if report.get("question") else ""
    if not question:
        return " ".join(parts)
    shown = f"{question[:MAX_LINE_QUESTION_LENGTH - 1]}…" if len(question) > MAX_LINE_QUESTION_LENGTH else question
    return f"{' '.join(parts)}: {shown}"


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
        "pane.associated": "JOINED",
        "pane.detached": "LEFT",
        "pr.conflicted": "PR CONFLICTED",
        "pr.checks": "PR CHECKS",
        "pr.merged": "PR MERGED",
        "agent.report": "REPORT",
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
            print_delivery((item.get("initialInput") or {}).get("delivery"), "  ")
            print_prompt_notes(item, "  ")
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
    trash = " (files are still being deleted in the background)" if result.get("trashDeletion") == "pending" else ""
    print(f"Archived pane {result.get('paneId')}{forced}. Worktree cleanup: {result.get('worktreeCleanup')}{trash}.")
    print_archive_skip_reason(result.get("safetyCheck") or {})
    merged = (result.get("safetyCheck") or {}).get("mergedViaPr")
    if merged:
        print(f"Merged via PR #{merged.get('number')} (head {merged.get('headOid')}).")


def print_pane_archive_bulk_result(result: Dict[str, Any]) -> None:
    verb = "Would archive" if result.get("dryRun") else "Archived"
    print(
        f"{verb} {result.get('archived')} Pane(s) in Session {result.get('sessionId')}; "
        f"skipped {result.get('skipped')}; failed {result.get('failed')}."
    )
    for item in result.get("items") or []:
        label = f"{item.get('name')} ({item.get('paneId')})" if item.get("name") else item.get("paneId")
        outcome = item.get("outcome")
        if outcome == "skipped":
            skipped = item.get("skipped") or {}
            print(f"  skipped {label}: {skipped.get('code', 'unknown')} - {skipped.get('message', '')}")
        elif outcome == "failed":
            print(f"  failed {label}: {item.get('error') or 'unknown error'}", file=sys.stderr)
        else:
            merged_pr = (item.get("safetyCheck") or {}).get("mergedViaPr")
            merged = f" merged via PR #{merged_pr.get('number')}" if merged_pr else ""
            trash = ", files deleting in background" if item.get("trashDeletion") == "pending" else ""
            cleanup = f" worktree {item.get('worktreeCleanup')}{trash}" if item.get("worktreeCleanup") else ""
            print(f"  {outcome} {label}{merged}{cleanup}")


def print_archive_skip_reason(safety_check: Dict[str, Any], file: Any = None) -> None:
    reason = safety_check.get("reason")
    if not reason:
        return
    remains = "; the worktree stays on disk" if safety_check.get("worktreeWillRemain") else ""
    print(f"Safety check skipped: {reason}{remains}.", file=file if file is not None else sys.stdout)


def print_archive_commit_evidence(safety_check: Dict[str, Any], file: Any = None) -> None:
    destination = file if file is not None else sys.stdout
    print_archive_skip_reason(safety_check, destination)
    upstream = safety_check.get("upstream")
    if upstream:
        refreshed = " (refreshed)" if safety_check.get("upstreamRefreshed") else ""
        gone = " (gone from the remote)" if safety_check.get("upstreamGone") else ""
        print(f"Upstream: {upstream}{refreshed}{gone}", file=destination)
    merged = safety_check.get("mergedViaPr")
    if merged:
        print(f"Merged via PR #{merged.get('number')} (head {merged.get('headOid')})", file=destination)
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
    print_prompt_notes(result)
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
        detection = panel.get("agentDetection")
        detection_label = f" ({detection})" if detection and detection != "command" else ""
        print(f"{marker} {panel.get('id')}\t{panel.get('type')}\t{panel.get('title')}{initialized}{agent}{detection_label}")


def optional_value(key: str, value: Any) -> Dict[str, Any]:
    return {key: value} if value is not None else {}


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))
