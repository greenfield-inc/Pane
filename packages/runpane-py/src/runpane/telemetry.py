from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from .version import wrapper_version
from .command_matching import match_command

TELEMETRY_ENDPOINT = "https://runpane.com/api/runpane/telemetry"
TELEMETRY_TIMEOUT_SECONDS = 1.5
INSTALL_ID_PREFIX = "install_"

WrapperTelemetryContext = Dict[str, Any]
WrapperTelemetryProperties = Dict[str, object]


def create_initial_telemetry_context(argv: Optional[List[str]] = None) -> WrapperTelemetryContext:
    args = list(sys.argv[1:] if argv is None else argv)
    first = args[0] if args else None
    if not first:
        return {"command": "setup", "resolved_command": "help"}
    if first in {"-h", "--help", "help"}:
        return {"command": "help", "resolved_command": "help"}
    if first in {"-v", "--version"}:
        return {"command": "version"}
    if first == "install":
        target = args[1] if len(args) > 1 and args[1] in {"client", "daemon"} else "client"
        return {"command": "install", "resolved_command": "install", "target": target}
    if first == "update":
        return {"command": "update", "resolved_command": "update", "target": "client"}
    if first == "doctor":
        return {"command": "doctor", "resolved_command": "doctor"}
    matched = match_command(args)
    return {"command": matched[0] if matched else "unknown"}


def apply_parsed_args_to_telemetry_context(context: WrapperTelemetryContext, parsed: object) -> None:
    command = getattr(parsed, "command")
    context["command"] = command
    context["target"] = "client" if command == "update" else getattr(parsed, "target")
    context["pane_version"] = getattr(parsed, "pane_version")
    context["channel"] = getattr(parsed, "channel")
    context["format"] = getattr(parsed, "format")
    context["dry_run"] = getattr(parsed, "dry_run")
    if command in {"install", "update"}:
        context["resolved_command"] = command
    if command == "help":
        context["resolved_command"] = "help"
    if command == "doctor":
        context["resolved_command"] = "doctor"


def set_setup_selection(
    context: WrapperTelemetryContext,
    resolved_command: str,
    target: Optional[str] = None,
) -> None:
    context["command"] = "setup"
    context["resolved_command"] = resolved_command
    if target:
        context["target"] = target


def categorize_failure(error: object) -> str:
    normalized = str(error).lower()
    if "checksum" in normalized:
        return "checksum"
    if "timeout" in normalized or "timed out" in normalized:
        return "timeout"
    if "enoent" in normalized or "not found" in normalized or "404" in normalized:
        return "not_found"
    if "permission" in normalized or "eacces" in normalized or "eperm" in normalized:
        return "permission"
    if "unsupported" in normalized:
        return "unsupported_platform"
    if "invalid" in normalized or "required" in normalized or "validation" in normalized:
        return "validation"
    if (
        "network" in normalized
        or "urlopen" in normalized
        or "socket" in normalized
        or "econn" in normalized
        or "enotfound" in normalized
    ):
        return "network"
    return "unknown"


def detect_python_invocation(env: Optional[Dict[str, str]] = None, argv: Optional[List[str]] = None) -> str:
    effective_env = os.environ if env is None else env
    args = list(sys.argv if argv is None else argv)
    argv_text = " ".join(str(arg).lower() for arg in args)
    executable = os.path.basename(sys.executable).lower()

    if effective_env.get("RUNPANE_PYTHON_INVOCATION") in {"pip", "pipx", "uvx", "python_module", "unknown"}:
        return effective_env["RUNPANE_PYTHON_INVOCATION"]
    if "pipx" in effective_env or "PIPX_HOME" in effective_env or "pipx" in argv_text:
        return "pipx"
    if any(key.startswith("UV_") for key in effective_env.keys()) or "uvx" in argv_text:
        return "uvx"
    if "__main__.py" in argv_text or "-m runpane" in argv_text:
        return "python_module"
    if executable.startswith("python"):
        return "pip"
    return "unknown"


def build_wrapper_telemetry_properties(
    install_id: str,
    invocation: str,
    context: WrapperTelemetryContext,
    version: Optional[str] = None,
) -> WrapperTelemetryProperties:
    properties: WrapperTelemetryProperties = {
        "install_id": install_id,
        "wrapper": "pip",
        "wrapper_version": _sanitize_short_string(version or wrapper_version()) or "unknown",
        "invocation": invocation,
        "command": context.get("command") or "unknown",
        "download_source": "pip",
    }

    _set_if_defined(properties, "resolved_command", context.get("resolved_command"))
    _set_if_defined(properties, "target", context.get("target"))
    platform = context.get("platform")
    if platform is not None:
        _set_if_defined(properties, "platform", getattr(platform, "os", None))
        _set_if_defined(properties, "arch", getattr(platform, "arch", None))
    _set_if_defined(properties, "pane_version", _sanitize_short_string(context.get("pane_version")))
    _set_if_defined(properties, "channel", context.get("channel"))
    _set_if_defined(properties, "format", context.get("resolved_format") or context.get("format"))
    _set_if_defined(properties, "dry_run", context.get("dry_run"))
    _set_if_defined(properties, "install_kind", context.get("install_kind"))
    _set_if_defined(properties, "used_fallback", context.get("used_fallback"))
    _set_if_defined(properties, "failure_stage", context.get("failure_stage"))
    _set_if_defined(properties, "failure_category", context.get("failure_category"))
    _set_if_defined(properties, "exit_code", _sanitize_exit_code(context.get("exit_code")))
    return properties


def track_wrapper_event(event: str, context: WrapperTelemetryContext) -> None:
    if _telemetry_disabled():
        return
    try:
        install_id = get_or_create_wrapper_install_id()
        properties = build_wrapper_telemetry_properties(
            install_id=install_id,
            invocation=detect_python_invocation(),
            context=context,
        )
        _post_telemetry({"event": event, "properties": properties})
    except Exception:
        return


def get_or_create_wrapper_install_id() -> str:
    app_dir = _app_directory()
    config_path = os.path.join(app_dir, "config.json")
    fallback_path = os.path.join(app_dir, "runpane-wrapper-identity.json")
    os.makedirs(app_dir, exist_ok=True)

    status, config = _read_config(config_path)
    if status == "ok" and config is not None:
        analytics = config.get("analytics") if isinstance(config.get("analytics"), dict) else {}
        existing = analytics.get("installId") if isinstance(analytics, dict) else None
        if isinstance(existing, str) and _valid_install_id(existing):
            return existing

        install_id = _create_install_id()
        next_config = dict(config)
        next_analytics = dict(analytics) if isinstance(analytics, dict) else {}
        next_analytics["installId"] = install_id
        next_config["analytics"] = next_analytics
        with open(config_path, "w", encoding="utf-8") as target:
            json.dump(next_config, target, indent=2)
            target.write("\n")
        return install_id

    if status == "missing":
        install_id = _create_install_id()
        with open(config_path, "w", encoding="utf-8") as target:
            json.dump({"analytics": {"installId": install_id}}, target, indent=2)
            target.write("\n")
        return install_id

    return _get_or_create_fallback_install_id(fallback_path)


def _read_config(config_path: str) -> tuple:
    try:
        with open(config_path, "r", encoding="utf-8") as source:
            parsed = json.load(source)
        return ("ok", parsed if isinstance(parsed, dict) else None)
    except FileNotFoundError:
        return ("missing", None)
    except Exception:
        return ("invalid", None)


def _get_or_create_fallback_install_id(fallback_path: str) -> str:
    try:
        with open(fallback_path, "r", encoding="utf-8") as source:
            parsed = json.load(source)
        existing = parsed.get("installId") if isinstance(parsed, dict) else None
        if isinstance(existing, str) and _valid_install_id(existing):
            return existing
    except Exception:
        pass

    install_id = _create_install_id()
    with open(fallback_path, "w", encoding="utf-8") as target:
        json.dump({"installId": install_id}, target, indent=2)
        target.write("\n")
    return install_id


def _post_telemetry(payload: Dict[str, object]) -> None:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        TELEMETRY_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "runpane-installer",
        },
        method="POST",
    )
    urllib.request.urlopen(request, timeout=TELEMETRY_TIMEOUT_SECONDS).close()


def _app_directory() -> str:
    return os.environ.get("PANE_DIR") or os.environ.get("FOOZOL_DIR") or os.path.join(os.path.expanduser("~"), ".pane")


def _telemetry_disabled() -> bool:
    return bool(os.environ.get("CI") or os.environ.get("RUNPANE_TELEMETRY_DISABLED"))


def _create_install_id() -> str:
    return f"{INSTALL_ID_PREFIX}{uuid.uuid4()}"


def _valid_install_id(value: str) -> bool:
    if not value.startswith(INSTALL_ID_PREFIX):
        return False
    try:
        uuid.UUID(value[len(INSTALL_ID_PREFIX):])
        return True
    except ValueError:
        return False


def _sanitize_short_string(value: object) -> Optional[str]:
    if not isinstance(value, str) or len(value) == 0 or len(value) > 80:
        return None
    if "/" in value or "\\" in value:
        return None
    return value


def _sanitize_exit_code(value: object) -> Optional[int]:
    if not isinstance(value, int) or value < 0 or value > 255:
        return None
    return value


def _set_if_defined(properties: WrapperTelemetryProperties, key: str, value: object) -> None:
    if value is not None:
        properties[key] = value
