from __future__ import annotations

import errno
import json
import os
import re
import sys
import time
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from .version import wrapper_version
from .command_matching import match_command

TELEMETRY_ENDPOINT = "https://runpane.com/api/runpane/telemetry"
TELEMETRY_TIMEOUT_SECONDS = 1.5
INSTALL_ID_PREFIX = "install_"
ERROR_CODE_PATTERN = re.compile(r"[A-Z][A-Z0-9_]{1,63}")
# Shared by both wrappers: a failure loop sends each cause once an hour and at most 10 failures an hour.
FAILURE_LIMIT_FILE = "runpane-wrapper-telemetry.json"
FAILURE_WINDOW_MS = 60 * 60 * 1000
MAX_FAILURES_PER_WINDOW = 10
CI_ENVIRONMENT_KEYS = ("CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI", "CIRCLECI", "TF_BUILD", "JENKINS_URL", "TEAMCITY_VERSION", "CODEBUILD_BUILD_ID")

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


def error_code_of(error: object) -> str:
    """The code `print_failure` shows: the error's own code, an OSError's errno name, else ERR_RUNPANE_FAILED."""
    code = getattr(error, "code", None)
    if isinstance(code, str):
        return code
    if isinstance(error, OSError) and error.errno in errno.errorcode:
        return errno.errorcode[error.errno]
    return "ERR_RUNPANE_FAILED"


def record_failure_cause(context: WrapperTelemetryContext, error: object) -> None:
    """Records a raised failure's code (the one its --json error prints) and, unless already set, its category."""
    context["error_code"] = error_code_of(error)
    context.setdefault("failure_category", categorize_failure(error))


def categorize_failure(error: object) -> str:
    """Reads the error code first, then only the message's first line, so appended help text cannot skew it."""
    code = error_code_of(error)
    if code in {"EACCES", "EPERM"}:
        return "permission"
    if code == "ENOENT":
        return "not_found"
    if code == "ETIMEDOUT" or code.endswith("_TIMEOUT"):
        return "timeout"
    if re.fullmatch(r"ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_RUNPANE_DAEMON_CONNECT_FAILED", code):
        return "network"
    normalized = str(error).split("\n", 1)[0].lower()
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
    error_code = context.get("error_code")
    _set_if_defined(properties, "error_code", error_code if isinstance(error_code, str) and ERROR_CODE_PATTERN.fullmatch(error_code) else None)
    _set_if_defined(properties, "exit_code", _sanitize_exit_code(context.get("exit_code")))
    return properties


def track_wrapper_event(event: str, context: WrapperTelemetryContext) -> None:
    if _telemetry_disabled():
        return
    try:
        status, config = _read_config(os.path.join(_app_directory(), "config.json"))
        if status == "ok" and isinstance(config, dict):
            analytics = config.get("analytics")
            if isinstance(analytics, dict) and analytics.get("enabled") is False:
                return
        install_id = get_or_create_wrapper_install_id()
        properties = build_wrapper_telemetry_properties(
            install_id=install_id,
            invocation=detect_python_invocation(),
            context=context,
        )
        if event.endswith("_failed") and not _allow_failure_event(event, properties):
            return
        _post_telemetry({"event": event, "properties": properties})
    except Exception:
        return


def _allow_failure_event(event: str, properties: WrapperTelemetryProperties) -> bool:
    path = os.path.join(_app_directory(), FAILURE_LIMIT_FILE)
    now = int(time.time() * 1000)
    signature = ":".join(str(properties.get(key, "")) for key in ("command", "failure_stage", "failure_category", "error_code", "exit_code"))
    signature = f"{event}:{signature}"
    window_start, count, sent = now, 0, []
    try:
        with open(path, "r", encoding="utf-8") as source:
            saved = json.load(source)
        saved_sent = [(str(entry["signature"]), int(entry["at"])) for entry in saved["sent"]]
        saved_start, saved_count = int(saved["windowStart"]), int(saved["count"])
        sent = saved_sent
        if saved_start <= now and now - saved_start < FAILURE_WINDOW_MS:
            window_start, count = saved_start, saved_count
    except Exception:
        pass  # A missing or unreadable file starts a new window.
    sent = [(key, sent_at) for key, sent_at in sent if now - sent_at < FAILURE_WINDOW_MS]
    if count >= MAX_FAILURES_PER_WINDOW or any(key == signature for key, _ in sent):
        return False
    sent.append((signature, now))
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as target:
        json.dump({"windowStart": window_start, "count": count + 1, "sent": [{"signature": key, "at": at} for key, at in sent]}, target)
        target.write("\n")
    os.replace(temporary, path)
    return True


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
    return (
        os.environ.get("DO_NOT_TRACK") == "1"
        or bool(os.environ.get("RUNPANE_TELEMETRY_DISABLED"))
        or any(os.environ.get(key) for key in CI_ENVIRONMENT_KEYS)
    )


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
    if value != "latest" and not re.fullmatch(r"v?\d+\.\d+\.\d+(?:-(?:nightly|alpha|beta|rc)[.-]?\d*)?", value):
        return None
    return value


def _sanitize_exit_code(value: object) -> Optional[int]:
    if not isinstance(value, int) or value < 0 or value > 255:
        return None
    return value


def _set_if_defined(properties: WrapperTelemetryProperties, key: str, value: object) -> None:
    if value is not None:
        properties[key] = value
