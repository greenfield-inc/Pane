from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
import os
import re
import socket
import sys
from typing import Callable, Dict, List, Optional, Set, Tuple, TypeVar

from .agent_context import run_agent_context
from .daemon_actions import contract_command, run_daemon_action, run_links_create
from .doctor import run_doctor
from .download import download_artifact
from .generated_contract import RUNPANE_CONTRACT
from .command_matching import match_command, is_runpane_local_command
from .installers import (
    install_pane_artifact,
    launch_pane_client,
    resolve_existing_pane_path,
    should_reuse_existing_pane,
    spawn_pane,
    spawn_pane_captured,
)
from .workspaces import read_workspace_summary
from .local_control import (
    has_cadence_value_flag,
    run_agents_doctor,
    run_lock_acquire,
    run_lock_list,
    run_lock_release,
    run_panels_create,
    run_panels_input,
    run_panels_last_message,
    run_panels_list,
    run_panels_output,
    run_panels_screen,
    run_panels_submit,
    run_panels_submit_composer,
    run_panels_wait,
    run_panes_adopt,
    run_panels_resume,
    run_panes_archive,
    run_panes_create,
    run_panes_focus,
    run_panels_open,
    run_panes_cost,
    run_panes_list,
    run_panes_pin,
    run_panes_rename,
    run_repos_add,
    run_repos_list,
    run_report,
    run_sessions_associate,
    run_sessions_create,
    run_sessions_detach,
    run_sessions_get,
    run_sessions_list,
    run_sessions_overview,
    run_sessions_set_agent,
    run_sessions_update,
    run_watch,
    run_workspace_state,
)
from .platforms import detect_platform
from .releases import resolve_release
from .telemetry import (
    WrapperTelemetryContext,
    apply_parsed_args_to_telemetry_context,
    categorize_failure,
    create_initial_telemetry_context,
    set_setup_selection,
    track_wrapper_event,
)
from .version import print_version

SOURCE = "pip"

TARGETS = set(RUNPANE_CONTRACT["enums"]["installTargets"])
FORMATS = set(RUNPANE_CONTRACT["enums"]["artifactFormats"])
CHANNELS = set(RUNPANE_CONTRACT["enums"]["channels"])
AGENTS = set(RUNPANE_CONTRACT["enums"]["agents"])
COMMAND_GROUP_HELP_TOPICS = {"panes", "panels", "workspace"}
COMMAND_GROUP_HELP_TOPICS.add("sessions")
COMMAND_GROUP_HELP_TOPICS.add("lock")
LOCK_DURATION_PATTERN = re.compile(r"^(\d+)(ms|s|m|h)?$")
LOCK_DURATION_UNIT_MS = {"ms": 1, "s": 1_000, "m": 60_000, "h": 3_600_000}
MAX_LOCK_DURATION_MS = 86_400_000

REMOTE_VALUE_FLAGS = {flag["name"] for flag in RUNPANE_CONTRACT["flags"]["remoteValue"]}
REMOTE_BOOLEAN_FLAGS = {flag["name"] for flag in RUNPANE_CONTRACT["flags"]["remoteBoolean"]}
LOCAL_VALUE_FLAGS = {
    value
    for flag in RUNPANE_CONTRACT["flags"]["localValue"]
    for value in [flag["name"], *flag.get("aliases", [])]
}
LOCAL_BOOLEAN_FLAGS = {
    value
    for flag in RUNPANE_CONTRACT["flags"]["localBoolean"]
    for value in [flag["name"], *flag.get("aliases", [])]
}
INLINE_VALUE_FLAGS = {
    *LOCAL_VALUE_FLAGS,
    *(flag["name"] for flag in RUNPANE_CONTRACT["flags"]["wrapper"] if "value" in flag),
    "--command",
}
DEFAULTS = RUNPANE_CONTRACT["defaults"]
REPORT_STATES = ["ready", "blocked", "failed", "done"]
HEAD_PATTERN = re.compile(r"[0-9a-fA-F]{7,40}")


@dataclass
class ParsedArgs:
    command: str
    target: str = DEFAULTS["target"]
    pane_version: str = DEFAULTS["paneVersion"]
    channel: str = DEFAULTS["channel"]
    format: str = DEFAULTS["format"]
    download_dir: Optional[str] = None
    pane_path: Optional[str] = None
    dry_run: bool = DEFAULTS["dryRun"]
    yes: bool = DEFAULTS["yes"]
    verbose: bool = DEFAULTS["verbose"]
    json: bool = False
    context_command: Optional[str] = None
    pane_dir: Optional[str] = None
    repo: Optional[str] = None
    pane_id: Optional[str] = None
    session_id: Optional[str] = None
    panel_id: Optional[str] = None
    repo_path: Optional[str] = None
    name: Optional[str] = None
    worktree_name: Optional[str] = None
    branch: Optional[str] = None
    base_branch: Optional[str] = None
    folder: Optional[str] = None
    resume: Optional[str] = None
    launch: bool = False
    agent: Optional[str] = None
    tool_command: Optional[str] = None
    title: Optional[str] = None
    url: Optional[str] = None
    file: Optional[str] = None
    placement: Optional[str] = None
    initial_input: Optional[str] = None
    initial_input_file: Optional[str] = None
    as_file_pointer: bool = False
    panel_input: Optional[str] = None
    panel_input_file: Optional[str] = None
    from_json: Optional[str] = None
    timeout_ms: Optional[float] = None
    wait_ready: bool = False
    ready_timeout_ms: Optional[float] = None
    concurrency: Optional[int] = None
    limit: Optional[int] = None
    wait_condition: Optional[str] = None
    contains: Optional[str] = None
    interval_ms: Optional[float] = None
    source: Optional[str] = None
    no_focus: bool = False
    focus: bool = False
    pinned: bool = False
    no_pinned: bool = False
    no_associate: bool = False
    composer_strategy: Optional[str] = None
    force: bool = False
    remove_worktree: bool = False
    merged: bool = False
    watch_as: Optional[str] = None
    watch_since: Optional[int] = None
    watch_from: Optional[str] = None
    watch_kinds: List[str] = field(default_factory=list)
    watch_pane_ids: List[str] = field(default_factory=list)
    watch_exclude_pane_ids: List[str] = field(default_factory=list)
    name_contains: Optional[str] = None
    follow: bool = False
    agents_only: bool = False
    ack_now: bool = False
    include_held_input: bool = False
    watch_format: Optional[str] = None
    heartbeat_seconds: Optional[int] = None
    idle_after_ms: Optional[int] = None
    settle_ms: Optional[int] = None
    blocked_settle_ms: Optional[int] = None
    min_interval_ms: Optional[int] = None
    idle_backoff: bool = False
    all_managed: bool = False
    include_shells: bool = False
    no_held_input: bool = False
    self_test: bool = False
    quiet: bool = False
    report: bool = False
    body_file: Optional[str] = None
    message: Optional[str] = None
    query: Optional[str] = None
    doc: Optional[str] = None
    url: Optional[str] = None
    folder: Optional[str] = None
    keys: Optional[List[str]] = None
    toolsets: Optional[List[str]] = None
    read_only: bool = False
    report_state: Optional[str] = None
    report_pr: Optional[int] = None
    report_head: Optional[str] = None
    summary: Optional[str] = None
    summary_file: Optional[str] = None
    question: Optional[str] = None
    lock_ttl_ms: Optional[int] = None
    lock_wait_ms: Optional[int] = None
    note: Optional[str] = None
    help_topic: Optional[str] = None
    remote_setup_args: List[str] = field(default_factory=list)


def main(argv: Optional[List[str]] = None) -> int:
    effective_argv = sys.argv[1:] if argv is None else argv
    telemetry_context = create_initial_telemetry_context(effective_argv)
    try:
        if not effective_argv:
            return run_tracked_command(
                telemetry_context,
                lambda: run_no_args_entrypoint(telemetry_context),
            )

        try:
            parsed = parse_args(effective_argv)
        except Exception as error:
            telemetry_context["failure_stage"] = "parse"
            telemetry_context["failure_category"] = categorize_failure(error)
            track_wrapper_event("runpane_wrapper_command_failed", telemetry_context)
            raise
        apply_parsed_args_to_telemetry_context(telemetry_context, parsed)

        if parsed.command == "version":
            return dispatch_parsed_command(parsed, telemetry_context)

        return run_tracked_command(
            telemetry_context,
            lambda: dispatch_parsed_command(parsed, telemetry_context),
        )
    except Exception as error:
        if effective_argv and effective_argv[0] == "watch":
            line = f"WATCH ERROR {type(error).__name__}: {error}"
            print(line, flush=True)
            print(line, file=sys.stderr, flush=True)
            return 2
        print(str(error), file=sys.stderr)
        return 1


def dispatch_parsed_command(parsed: ParsedArgs, telemetry_context: WrapperTelemetryContext) -> int:
    handler = COMMAND_HANDLERS.get(parsed.command)
    if handler is None:
        raise ValueError(f"Unsupported command: {parsed.command}")
    return handler(parsed, telemetry_context)


def run_tracked_command(telemetry_context: WrapperTelemetryContext, execute: Callable[[], int]) -> int:
    track_wrapper_event("runpane_wrapper_command_started", telemetry_context)
    try:
        code = execute()
        telemetry_context["exit_code"] = code
        if code == 0:
            track_wrapper_event("runpane_wrapper_command_succeeded", telemetry_context)
        else:
            telemetry_context.setdefault("failure_stage", infer_failure_stage(telemetry_context))
            telemetry_context.setdefault("failure_category", "process_exit")
            track_wrapper_event("runpane_wrapper_command_failed", telemetry_context)
        return code
    except Exception as error:
        telemetry_context.setdefault("failure_stage", "unknown")
        telemetry_context.setdefault("failure_category", categorize_failure(error))
        track_wrapper_event("runpane_wrapper_command_failed", telemetry_context)
        raise


def infer_failure_stage(telemetry_context: WrapperTelemetryContext) -> str:
    if telemetry_context.get("resolved_command") == "install" and telemetry_context.get("target") == "daemon":
        return "remote_setup"
    return "unknown"


def run_no_args_entrypoint(telemetry_context: WrapperTelemetryContext) -> int:
    if not is_interactive_shell():
        telemetry_context["resolved_command"] = "help"
        print(help_text(None))
        return 0

    return run_interactive_wizard(telemetry_context)


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))


def run_interactive_wizard(telemetry_context: WrapperTelemetryContext) -> int:
    print("Pane setup")
    print("Choose what this machine should do. You can rerun setup any time.")
    print("Commands: runpane help, runpane doctor, runpane doctor --json, runpane agent-context --json")
    print()
    print("1) Install Pane desktop app on this machine")
    print("2) Set up this machine as a remote host")
    print("3) Update Pane desktop app")
    print("4) Run diagnostics")
    print()

    action = ask_choice("Choose an action [1]: ", {
        "": "client",
        "1": "client",
        "client": "client",
        "install": "client",
        "desktop": "client",
        "2": "daemon",
        "daemon": "daemon",
        "remote": "daemon",
        "host": "daemon",
        "3": "update",
        "update": "update",
        "4": "doctor",
        "doctor": "doctor",
        "diagnostics": "doctor",
    })

    if action == "client":
        print()
        print("Installing Pane desktop app on this machine...")
        set_setup_selection(telemetry_context, "install", "client")
        return install_or_update(create_parsed_args("install", target="client"), telemetry_context)
    if action == "update":
        print()
        print("Updating Pane desktop app on this machine...")
        set_setup_selection(telemetry_context, "update", "client")
        return install_or_update(create_parsed_args("update", target="client"), telemetry_context)
    if action == "doctor":
        print()
        print("Running runpane diagnostics...")
        set_setup_selection(telemetry_context, "doctor")
        return run_doctor(create_parsed_args("doctor"), SOURCE)

    print()
    print("A remote host runs your repos, terminals, agents, and git state.")
    print("Your desktop Pane or browser client connects with the generated pane-remote:// code.")

    default_label = socket.gethostname() or "Remote Host"
    label = input(f"Remote host label [{default_label}]: ").strip() or default_label

    print()
    print("Pane will install Tailscale if needed and guide you through signing in.")
    print("For SSH or a manual URL, use runpane install daemon --help.")
    remote_setup_args = [
        "--label", label,
        "--prefer-tunnel", "tailscale",
        "--interactive-tailscale-setup",
        "--auto-listen-port",
    ]

    print()
    print("Setting up this machine as a Pane remote host...")
    print("When setup finishes, paste the printed pane-remote:// code into Pane or runpane.com/app.")

    set_setup_selection(telemetry_context, "install", "daemon")
    return install_or_update(create_parsed_args(
        "install",
        target="daemon",
        remote_setup_args=remote_setup_args,
    ), telemetry_context)


ChoiceT = TypeVar("ChoiceT", bound=str)


def ask_choice(prompt: str, choices: Dict[str, ChoiceT]) -> ChoiceT:
    while True:
        answer = input(prompt).strip().lower()
        choice = choices.get(answer)
        if choice:
            return choice
        print(f"Choose one of: {', '.join(key for key in choices.keys() if key)}")


def create_parsed_args(command: str, **overrides: object) -> ParsedArgs:
    parsed = ParsedArgs(command=command)
    for key, value in overrides.items():
        setattr(parsed, key, value)
    return parsed


def take_leading_pane_dir(args: List[str]) -> List[str]:
    # `runpane --pane-dir <dir> <command>` puts the global flag before the command;
    # set those tokens aside so the command matches, then parse them with the flags.
    taken: List[str] = []
    while args and (args[0] == "--pane-dir" or args[0].startswith("--pane-dir=")):
        width = 2 if args[0] == "--pane-dir" else 1
        taken.extend(args[:width])
        del args[:width]
    return taken


def parse_args(argv: List[str]) -> ParsedArgs:
    args = list(argv)
    leading_pane_dir_args = take_leading_pane_dir(args)
    if not args or args[0] in {"-h", "--help"}:
        return ParsedArgs(command="help")
    first = args[0]
    if first in {"-v", "--version"}:
        return ParsedArgs(command="version")
    if first == "help":
        args.pop(0)
        return ParsedArgs(command="help", help_topic=" ".join(args) or None)

    group_help_topic = match_command_group_help(args)
    if group_help_topic:
        return ParsedArgs(command="help", help_topic=group_help_topic)

    matched = match_command(args)
    if not matched:
        raise ValueError(f"Unknown command: {first}\n\n{help_text(None)}")

    command, tokens = matched
    del args[:len(tokens)]

    parsed = ParsedArgs(command=command)
    if parsed.command == "install" and args and not args[0].startswith("-"):
        target = args.pop(0)
        if target not in TARGETS:
            raise ValueError(f'Unknown install target: {target}. Expected "client" or "daemon".')
        parsed.target = target

    if parsed.command == "update":
        parsed.target = "client"

    args[:0] = leading_pane_dir_args
    parse_flags(args, parsed)
    if parsed.command == "panes archive":
        validate_panes_archive_args(parsed)
    if parsed.command == "watch" and parsed.follow and parsed.timeout_ms == 0:
        raise ValueError("--timeout-ms must be greater than 0 with --follow.")
    if parsed.command == "watch" and parsed.session_id is not None and parsed.watch_pane_ids:
        raise ValueError(
            "runpane watch accepts either --session or --pane, not both; "
            "--session already follows every Pane in the Session."
        )
    if parsed.command == "watch" and parsed.session_id is not None and parsed.all_managed:
        raise ValueError("runpane watch accepts either --session or --all-managed, not both.")
    if parsed.command == "watch" and parsed.all_managed and parsed.watch_pane_ids:
        raise ValueError("runpane watch accepts either --all-managed or --pane, not both.")
    if parsed.command == "watch" and parsed.json and parsed.watch_format == "lines":
        raise ValueError("runpane watch accepts either --json or --format lines, not both.")
    cadence_value_flag_present = has_cadence_value_flag(parsed)
    if parsed.command == "watch" and not parsed.follow and (cadence_value_flag_present or parsed.idle_backoff):
        raise ValueError("--settle, --blocked-settle, --min-interval, and --idle-backoff require --follow.")
    if parsed.command == "watch" and parsed.watch_since is not None and cadence_value_flag_present:
        raise ValueError(
            "runpane watch accepts either --since or --settle/--blocked-settle/--min-interval, not both (cadence needs a named cursor)."
        )
    if parsed.command == "report":
        validate_report_args(parsed)
    return parsed


def validate_report_args(parsed: ParsedArgs) -> None:
    if not parsed.report_state:
        raise ValueError(f"runpane report requires --state <{'|'.join(REPORT_STATES)}>.")
    if parsed.summary is not None and parsed.summary_file is not None:
        raise ValueError("runpane report accepts either --summary or --summary-file, not both.")
    if parsed.report_state == "blocked" and not (parsed.question or "").strip():
        raise ValueError('runpane report --state blocked requires --question "<what you need answered>".')


def validate_panes_archive_args(parsed: ParsedArgs) -> None:
    if parsed.pane_id and parsed.session_id:
        raise ValueError("runpane panes archive accepts either --pane or --session, not both.")
    if parsed.merged and not parsed.session_id:
        raise ValueError("--merged requires --session.")
    if parsed.session_id and not parsed.merged:
        raise ValueError("runpane panes archive --session requires --merged.")
    if parsed.session_id and parsed.force:
        raise ValueError(
            "runpane panes archive --session does not accept --force; archive one Pane with --pane to discard its work."
        )


def parse_lock_ttl(value: str) -> int:
    """A lock TTL such as 90s, 30m, or 2h; a bare number is milliseconds."""
    match = LOCK_DURATION_PATTERN.match(value.strip())
    if not match:
        raise ValueError("--ttl must be a duration such as 90s, 30m, or 2h (a bare number is milliseconds).")
    ttl_ms = int(match.group(1)) * LOCK_DURATION_UNIT_MS[match.group(2) or "ms"]
    if ttl_ms < 1_000 or ttl_ms > MAX_LOCK_DURATION_MS:
        raise ValueError("--ttl must be between 1s and 24h.")
    return ttl_ms


def parse_non_negative_int_flag(flag: str, value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise ValueError(f"{flag} must be a non-negative integer.") from error
    if parsed < 0:
        raise ValueError(f"{flag} must be a non-negative integer.")
    return parsed


def split_inline_values(raw_args: List[str]) -> Tuple[List[str], Set[int]]:
    """Split `--flag=value` for runpane's own value flags; such values are literal even if they start with "-"."""
    args: List[str] = []
    literal_values: Set[int] = set()
    for arg in raw_args:
        flag, separator, value = arg.partition("=")
        if separator and flag in INLINE_VALUE_FLAGS:
            args.append(flag)
            literal_values.add(len(args))
            args.append(value)
        else:
            args.append(arg)
    return args, literal_values


def parse_flags(raw_args: List[str], parsed: ParsedArgs) -> None:
    args, literal_values = split_inline_values(raw_args)
    index = 0
    while index < len(args):
        arg = args[index]
        is_agent_context_command = parsed.command == "agent-context"
        is_local_command = is_runpane_local_command(parsed.command)
        if arg in {"-h", "--help"}:
            parsed.help_topic = parsed.command
            parsed.command = "help"
        elif arg == "--dry-run":
            parsed.dry_run = True
        elif arg in {"--yes", "-y"}:
            parsed.yes = True
        elif arg == "--verbose":
            parsed.verbose = True
        elif is_agent_context_command and arg == "--json":
            parsed.json = True
        elif is_agent_context_command and arg == "--command":
            index += 1
            parsed.context_command = read_value(args, index, arg, literal_values)
        elif (is_agent_context_command or parsed.command == "version") and arg == "--pane-dir":
            # Offline commands accept --pane-dir and ignore it, so one --pane-dir works for every command.
            index += 1
            parsed.pane_dir = read_value(args, index, arg, literal_values)
        elif is_local_command and arg in LOCAL_BOOLEAN_FLAGS:
            parse_local_boolean_flag(parsed, arg)
        elif is_local_command and arg in LOCAL_VALUE_FLAGS:
            index += 1
            parse_local_value_flag(parsed, arg, read_value(args, index, arg, literal_values))
        elif arg == "--version":
            index += 1
            parsed.pane_version = read_value(args, index, arg, literal_values)
        elif arg == "--download-dir":
            index += 1
            parsed.download_dir = read_value(args, index, arg, literal_values)
        elif arg == "--pane-path":
            index += 1
            parsed.pane_path = read_value(args, index, arg, literal_values)
        elif arg == "--format":
            index += 1
            value = read_value(args, index, arg, literal_values)
            if value not in FORMATS:
                raise ValueError(f"Invalid --format {value}. Expected one of: {', '.join(sorted(FORMATS))}")
            parsed.format = value
        elif arg in REMOTE_VALUE_FLAGS:
            index += 1
            value = read_value(args, index, arg, literal_values)
            if arg == "--channel":
                if value not in CHANNELS:
                    raise ValueError(f"Invalid --channel {value}. Expected stable or nightly.")
                parsed.channel = value
            append_remote_arg(parsed, arg, value)
        elif arg in REMOTE_BOOLEAN_FLAGS:
            append_remote_arg(parsed, arg)
        elif parsed.command == "install" and parsed.target == "daemon":
            parsed.remote_setup_args.append(arg)
            if arg.startswith("-") and index + 1 < len(args) and not args[index + 1].startswith("-"):
                index += 1
                parsed.remote_setup_args.append(args[index])
        else:
            raise ValueError(f"Unknown option for {parsed.command}: {arg}")
        index += 1



def match_command_group_help(args: List[str]) -> Optional[str]:
    if len(args) != 2 or args[1] not in {"-h", "--help"}:
        return None
    return args[0] if args[0] in COMMAND_GROUP_HELP_TOPICS else None


def parse_local_boolean_flag(parsed: ParsedArgs, flag: str) -> None:
    if flag == "--json":
        parsed.json = True
        return
    if flag == "--wait-ready":
        parsed.wait_ready = True
        return
    if flag == "--no-focus":
        parsed.no_focus = True
        return
    if flag == "--focus":
        parsed.focus = True
        return
    if flag in {"--split", "--tab"}:
        placement = flag[2:]
        if parsed.placement and parsed.placement != placement:
            raise ValueError("Use either --split or --tab, not both.")
        parsed.placement = placement
        return
    if flag == "--pinned":
        parsed.pinned = True
        return
    if flag == "--launch":
        parsed.launch = True
        return
    if flag == "--no-pinned":
        parsed.no_pinned = True
        return
    if flag == "--no-associate":
        parsed.no_associate = True
        return
    if flag == "--force":
        parsed.force = True
        return
    if flag == "--as-file-pointer":
        parsed.as_file_pointer = True
        return
    if flag == "--remove-worktree":
        parsed.remove_worktree = True
        return
    if flag == "--merged":
        parsed.merged = True
        return
    if flag == "--follow":
        parsed.follow = True
        return
    if flag == "--idle-backoff":
        parsed.idle_backoff = True
        return
    if flag == "--ack-now":
        parsed.ack_now = True
        return
    if flag == "--include-held-input":
        parsed.include_held_input = True
        return
    if flag == "--agents-only":
        parsed.agents_only = True
        return
    if flag == "--all-managed":
        parsed.all_managed = True
        return
    if flag == "--include-shells":
        parsed.include_shells = True
        return
    if flag == "--no-held-input":
        parsed.no_held_input = True
        return
    if flag == "--self-test":
        parsed.self_test = True
        return
    if flag in {"--quiet", "--no-control-lines"}:
        if parsed.command != "watch":
            raise ValueError(f"{flag} is only valid with runpane watch.")
        parsed.quiet = True
        return
    if flag == "--report":
        parsed.report = True
        return
    if flag == "--read-only":
        parsed.read_only = True
        return
    raise ValueError(f"Unknown option for {parsed.command}: {flag}")


def parse_local_value_flag(parsed: ParsedArgs, flag: str, value: str) -> None:
    if flag == "--pane-dir":
        parsed.pane_dir = value
        return
    if flag == "--repo":
        parsed.repo = value
        return
    if flag == "--pane":
        if parsed.command == "watch":
            parsed.watch_pane_ids.append(value)
        else:
            parsed.pane_id = value
        return
    if flag == "--session":
        parsed.session_id = value
        return
    if flag == "--exclude-pane":
        parsed.watch_exclude_pane_ids.append(value)
        return
    if flag == "--panel":
        parsed.panel_id = value
        return
    if flag == "--path":
        parsed.repo_path = value
        return
    if flag == "--url":
        parsed.url = value
        return
    if flag == "--file":
        parsed.file = value
        return
    if flag == "--folder":
        parsed.folder = value
        return
    if flag == "--resume":
        parsed.resume = value
        return
    if flag == "--name":
        parsed.name = value
        return
    if flag == "--worktree-name":
        parsed.worktree_name = value
        return
    if flag == "--branch":
        parsed.branch = value
        return
    if flag in {"--base-branch", "--base"}:
        parsed.base_branch = value
        return
    if flag == "--agent":
        if value not in AGENTS:
            raise ValueError(f"Invalid --agent {value}. Expected one of: {', '.join(sorted(AGENTS))}")
        parsed.agent = value
        return
    if flag == "--tool-command":
        parsed.tool_command = value
        return
    if flag == "--title":
        parsed.title = value
        return
    if flag in {"--initial-input", "--prompt"}:
        parsed.initial_input = value
        return
    if flag == "--text":
        parsed.panel_input = value
        return
    if flag == "--input-file":
        parsed.panel_input_file = value
        return
    if flag in {"--initial-input-file", "--prompt-file"}:
        parsed.initial_input_file = value
        return
    if flag == "--from-json":
        parsed.from_json = value
        return
    if flag == "--timeout-ms":
        try:
            timeout_ms = float(value)
        except ValueError as error:
            raise ValueError("--timeout-ms must be a positive number.") from error
        if not math.isfinite(timeout_ms) or timeout_ms < 0 or (timeout_ms == 0 and parsed.command != "watch"):
            raise ValueError("--timeout-ms must be a positive number (watch also accepts 0).")
        parsed.timeout_ms = timeout_ms
        return
    if flag == "--ready-timeout-ms":
        try:
            ready_timeout_ms = float(value)
        except ValueError as error:
            raise ValueError("--ready-timeout-ms must be a positive number.") from error
        if not math.isfinite(ready_timeout_ms) or ready_timeout_ms <= 0:
            raise ValueError("--ready-timeout-ms must be a positive number.")
        parsed.ready_timeout_ms = ready_timeout_ms
        return
    if flag == "--concurrency":
        try:
            concurrency = int(value)
        except ValueError as error:
            raise ValueError("--concurrency must be a positive integer.") from error
        if concurrency <= 0:
            raise ValueError("--concurrency must be a positive integer.")
        parsed.concurrency = concurrency
        return
    if flag == "--limit":
        try:
            limit = int(value)
        except ValueError as error:
            raise ValueError("--limit must be a positive integer.") from error
        if limit <= 0:
            raise ValueError("--limit must be a positive integer.")
        parsed.limit = limit
        return
    if flag == "--for":
        if value not in {"initialized", "ready", "idle", "text"}:
            raise ValueError("--for must be one of: initialized, ready, idle, text.")
        parsed.wait_condition = value
        return
    if flag == "--contains":
        parsed.contains = value
        return
    if flag == "--interval-ms":
        try:
            interval_ms = float(value)
        except ValueError as error:
            raise ValueError("--interval-ms must be a positive number.") from error
        if not math.isfinite(interval_ms) or interval_ms <= 0:
            raise ValueError("--interval-ms must be a positive number.")
        parsed.interval_ms = interval_ms
        return
    if flag == "--source":
        if value not in {"user", "agent"}:
            raise ValueError("--source must be one of: user, agent.")
        parsed.source = value
        return
    if flag == "--strategy":
        if value not in {"auto", "codex-ctrl-enter", "enter"}:
            raise ValueError("--strategy must be one of: auto, codex-ctrl-enter, enter.")
        parsed.composer_strategy = value
        return
    if flag == "--as":
        parsed.watch_as = value
        return
    if flag == "--since":
        try:
            since = int(value)
        except ValueError as error:
            raise ValueError("--since must be a non-negative integer.") from error
        if since < 0:
            raise ValueError("--since must be a non-negative integer.")
        parsed.watch_since = since
        return
    if flag == "--from":
        if value not in {"now", "earliest"}:
            raise ValueError("--from must be now or earliest.")
        parsed.watch_from = value
        return
    if flag == "--kinds":
        parsed.watch_kinds = [kind.strip() for kind in value.split(",") if kind.strip()]
        return
    if flag == "--name-contains":
        parsed.name_contains = value
        return
    if flag == "--format":
        if parsed.command == "watch":
            if value not in {"lines", "json"}:
                raise ValueError("--format for watch must be lines or json.")
            parsed.watch_format = value
            return
        if value not in FORMATS:
            raise ValueError(f"Invalid --format {value}. Expected one of: {', '.join(sorted(FORMATS))}")
        parsed.format = value
        return
    if flag == "--heartbeat":
        parsed.heartbeat_seconds = parse_non_negative_int_flag(flag, value)
        return
    if flag == "--idle-after":
        parsed.idle_after_ms = parse_non_negative_int_flag(flag, value)
        return
    if flag == "--settle":
        parsed.settle_ms = parse_non_negative_int_flag(flag, value)
        return
    if flag == "--blocked-settle":
        parsed.blocked_settle_ms = parse_non_negative_int_flag(flag, value)
        return
    if flag == "--min-interval":
        parsed.min_interval_ms = parse_non_negative_int_flag(flag, value)
        return
    if flag == "--body-file":
        parsed.body_file = value
        return
    if flag == "--message":
        parsed.message = value
        return
    if flag == "--query":
        parsed.query = value
        return
    if flag == "--doc":
        parsed.doc = value
        return
    if flag == "--url":
        parsed.url = value
        return
    if flag == "--folder":
        parsed.folder = value
        return
    if flag == "--keys":
        parsed.keys = [key.strip() for key in value.split(",") if key.strip()]
        return
    if flag == "--toolsets":
        parsed.toolsets = [name.strip() for name in value.split(",") if name.strip()]
        return
    if flag == "--state":
        if value not in REPORT_STATES:
            raise ValueError(f"--state must be one of: {', '.join(REPORT_STATES)}.")
        parsed.report_state = value
        return
    if flag == "--pr":
        if not re.fullmatch(r"[0-9]+", value) or int(value) <= 0 or int(value) > 9007199254740991:
            raise ValueError("--pr must be a positive integer.")
        parsed.report_pr = int(value)
        return
    if flag == "--head":
        if not HEAD_PATTERN.fullmatch(value):
            raise ValueError("--head must be a commit SHA of 7 to 40 hex characters.")
        parsed.report_head = value.lower()
        return
    if flag == "--summary":
        parsed.summary = value
        return
    if flag == "--summary-file":
        parsed.summary_file = value
        return
    if flag == "--question":
        parsed.question = value
        return
    if flag == "--ttl":
        parsed.lock_ttl_ms = parse_lock_ttl(value)
        return
    if flag == "--wait":
        wait_ms = parse_non_negative_int_flag(flag, value)
        if wait_ms > MAX_LOCK_DURATION_MS:
            raise ValueError("--wait must be at most 86400000 (24h).")
        parsed.lock_wait_ms = wait_ms
        return
    if flag == "--note":
        parsed.note = value
        return
    raise ValueError(f"Unknown option for {parsed.command}: {flag}")




def append_remote_arg(parsed: ParsedArgs, flag: str, value: Optional[str] = None) -> None:
    if parsed.command == "install" and parsed.target == "daemon":
        parsed.remote_setup_args.append(flag)
        if value is not None:
            parsed.remote_setup_args.append(value)
        return
    raise ValueError(f'{flag} is only valid with "runpane install daemon".')


def read_value(args: List[str], index: int, flag: str, literal_values: Set[int]) -> str:
    if index in literal_values:
        return args[index]
    free_text = flag in {"--text", "--prompt", "--initial-input", "--title", "--name", "--name-contains"}
    if index >= len(args) or not args[index] or (not free_text and args[index].startswith("-") and args[index] != "-"):
        raise ValueError(f"{flag} requires a value.")
    return args[index]


def run_daemon_repair(parsed: ParsedArgs) -> int:
    executable = resolve_existing_pane_path(parsed.pane_path)
    if not executable:
        raise RuntimeError("Pane is not installed. Install Pane first, then rerun runpane daemon repair.")
    confirm_daemon_repair(parsed)
    pane_dir = parsed.pane_dir or os.path.join(os.path.expanduser("~"), ".pane_remote")
    args = ["--remote-setup", "--remote-repair-service", "--pane-dir", pane_dir]
    if parsed.json:
        child = spawn_pane_captured(executable, [*args, "--json"])
        try:
            result = json.loads(child.stdout.strip())
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f"Pane returned an invalid daemon repair result: {child.stderr.strip() or error}"
            ) from error
        if not valid_daemon_repair_result(result):
            raise RuntimeError("Pane returned an invalid daemon repair result: response did not match the contract schema.")
        print(json.dumps(result, indent=2))
        return 0 if child.returncode == 0 and result["ok"] is True else 1
    print(f"runpane: repairing the remote daemon service in {pane_dir}...")
    return spawn_pane(executable, args)


def valid_daemon_repair_result(result) -> bool:
    if not isinstance(result, dict):
        return False
    return (
        type(result.get("ok")) is bool
        and type(result.get("changed")) is bool
        and isinstance(result.get("paneDir"), str)
        and result.get("strategy") in {"systemd-user", "launch-agent", "scheduled-task", "manual", "skipped"}
        and isinstance(result.get("launcherPath"), str)
        and isinstance(result.get("before"), dict)
        and isinstance(result.get("after"), dict)
        and isinstance(result.get("message"), str)
    )


def confirm_daemon_repair(parsed: ParsedArgs) -> None:
    if parsed.yes:
        return
    if parsed.json or not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError("runpane daemon repair restarts the remote daemon service. Rerun with --yes to confirm.")
    answer = input("Repair and restart the Pane remote daemon service? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise RuntimeError("Daemon repair cancelled.")


def install_or_update(parsed: ParsedArgs, telemetry_context: Optional[WrapperTelemetryContext] = None) -> int:
    target = "client" if parsed.command == "update" else parsed.target
    context = telemetry_context if telemetry_context is not None else create_install_telemetry_context(parsed, target)
    context["target"] = target
    context["pane_version"] = parsed.pane_version
    context["channel"] = parsed.channel
    context["format"] = parsed.format
    context["dry_run"] = parsed.dry_run

    if not parsed.dry_run and should_reuse_existing_pane(parsed, target):
        existing = resolve_existing_pane_path(parsed.pane_path)
        if existing:
            print(f"runpane: using existing Pane executable at {existing}")
            print("runpane: starting remote setup...")
            context["install_kind"] = "existing"
            code = spawn_pane(existing, ["--remote-setup", *parsed.remote_setup_args])
            context["exit_code"] = code
            if code != 0:
                context["failure_stage"] = "remote_setup"
                context["failure_category"] = "process_exit"
            return code

    try:
        platform = detect_platform()
        context["platform"] = platform
    except Exception as error:
        context["failure_stage"] = "resolve_release"
        context["failure_category"] = categorize_failure(error)
        raise

    print(f"runpane: resolving Pane release {parsed.pane_version}...")
    try:
        resolved = resolve_release(
            version=parsed.pane_version,
            channel=parsed.channel,
            source=SOURCE,
            platform=platform,
            format_name=parsed.format,
            target=target,
        )
        context["resolved_format"] = resolved.format
    except Exception as error:
        context["failure_stage"] = "resolve_release"
        context["failure_category"] = categorize_failure(error)
        raise

    if parsed.dry_run:
        print("runpane dry run")
        print(f"Command: {parsed.command}")
        print(f"Target: {target}")
        print(f"Pane release: {parsed.pane_version}")
        print(f"Channel: {parsed.channel}")
        print(f"Format: {parsed.format}")
        print(f"Artifact: {resolved.artifact['name']}")
        print(f"Preferred download: {resolved.preferred_download_url}")
        print(f"GitHub fallback: {resolved.fallback_download_url}")
        if parsed.pane_path:
            print(f"Existing Pane path: {parsed.pane_path}")
        if target == "daemon":
            forwarded = " ".join(parsed.remote_setup_args)
            print(f"Pane command: <pane executable> --remote-setup {forwarded}".strip())
        return 0

    print(f"runpane: selected {resolved.artifact['name']}")
    print(f"runpane: downloading {resolved.artifact['name']}...")
    track_wrapper_event("runpane_wrapper_download_requested", context)

    def on_fallback_used(error: Exception) -> None:
        fallback_context = dict(context)
        fallback_context["used_fallback"] = True
        fallback_context["failure_stage"] = "download"
        fallback_context["failure_category"] = categorize_failure(error)
        track_wrapper_event("runpane_wrapper_github_fallback_used", fallback_context)

    try:
        artifact = download_artifact(
            resolved,
            parsed.download_dir,
            parsed.verbose,
            on_fallback_used=on_fallback_used,
        )
        context["used_fallback"] = artifact.used_fallback
        track_wrapper_event("runpane_wrapper_download_succeeded", context)
    except Exception as error:
        failure_category = categorize_failure(error)
        context["failure_stage"] = "checksum" if failure_category == "checksum" else "download"
        context["failure_category"] = failure_category
        track_wrapper_event("runpane_wrapper_download_failed", context)
        raise

    fallback = " from GitHub fallback" if artifact.used_fallback else ""
    print(f"runpane: downloaded {artifact.file_name}{fallback}")
    print("runpane: installing Pane...")
    try:
        installed = install_pane_artifact(artifact, parsed, platform, resolved.format, target)
        context["install_kind"] = installed.install_kind
    except Exception as error:
        context["failure_stage"] = "install"
        context["failure_category"] = categorize_failure(error)
        raise

    if target == "daemon":
        print("runpane: starting remote setup...")
        code = spawn_pane(installed.executable_path, ["--remote-setup", *parsed.remote_setup_args])
        context["exit_code"] = code
        if code != 0:
            context["failure_stage"] = "remote_setup"
            context["failure_category"] = "process_exit"
        return code

    if installed.install_kind == "installed":
        try:
            launch_pane_client(installed.executable_path)
        except Exception as error:
            context["failure_stage"] = "launch"
            context["failure_category"] = categorize_failure(error)
            raise

    print(f"Pane {installed.install_kind}: {installed.executable_path}")
    return 0


def create_install_telemetry_context(parsed: ParsedArgs, target: str) -> WrapperTelemetryContext:
    return {
        "command": parsed.command,
        "resolved_command": parsed.command if parsed.command in {"install", "update"} else None,
        "target": target,
        "pane_version": parsed.pane_version,
        "channel": parsed.channel,
        "format": parsed.format,
        "dry_run": parsed.dry_run,
    }


def help_text(topic: Optional[str]) -> str:
    help_topics = RUNPANE_CONTRACT["help"]["pip"]
    return "\n".join(help_topics.get(topic or "default", help_topics["default"]))


def print_help(parsed: ParsedArgs) -> int:
    print(help_text(parsed.help_topic))
    if not parsed.help_topic or parsed.help_topic == "workspace":
        print("\n".join(["", *read_workspace_summary(parsed.pane_dir)["lines"]]))
    return 0


def run_unsupported_contract(parsed: ParsedArgs, context: WrapperTelemetryContext) -> int:
    print(help_text(parsed.command), file=sys.stderr)
    return 2

COMMAND_HANDLERS: Dict[str, Callable[[ParsedArgs, WrapperTelemetryContext], int]] = {
    "setup": lambda parsed, context: run_no_args_entrypoint(context),
    "version": lambda parsed, context: print_version(parsed.pane_path),
    "doctor": lambda parsed, context: run_doctor(parsed, SOURCE),
    "daemon repair": lambda parsed, context: run_daemon_repair(parsed),
    "agent-context": lambda parsed, context: run_agent_context(parsed),
    "links create": lambda parsed, context: run_links_create(parsed),
    "repos list": lambda parsed, context: run_repos_list(parsed),
    "repos add": lambda parsed, context: run_repos_add(parsed),
    "sessions list": lambda parsed, context: run_sessions_list(parsed),
    "sessions create": lambda parsed, context: run_sessions_create(parsed),
    "sessions get": lambda parsed, context: run_sessions_get(parsed),
    "sessions update": lambda parsed, context: run_sessions_update(parsed),
    "sessions set-agent": lambda parsed, context: run_sessions_set_agent(parsed),
    "sessions associate": lambda parsed, context: run_sessions_associate(parsed),
    "sessions detach": lambda parsed, context: run_sessions_detach(parsed),
    "sessions overview": lambda parsed, context: run_sessions_overview(parsed),
    "lock acquire": lambda parsed, context: run_lock_acquire(parsed),
    "lock release": lambda parsed, context: run_lock_release(parsed),
    "lock list": lambda parsed, context: run_lock_list(parsed),
    "panes list": lambda parsed, context: run_panes_list(parsed),
    "panes cost": lambda parsed, context: run_panes_cost(parsed),
    "workspace state": lambda parsed, context: run_workspace_state(parsed),
    "watch": lambda parsed, context: run_watch(parsed),
    "workspace list": lambda parsed, context: run_unsupported_contract(parsed, context),
    "workspace enable": lambda parsed, context: run_unsupported_contract(parsed, context),
    "workspace disable": lambda parsed, context: run_unsupported_contract(parsed, context),
    "workspace read": lambda parsed, context: run_unsupported_contract(parsed, context),
    "workspace write": lambda parsed, context: run_unsupported_contract(parsed, context),
    "workspace exec": lambda parsed, context: run_unsupported_contract(parsed, context),
    "handoff": lambda parsed, context: run_unsupported_contract(parsed, context),
    "panes create": lambda parsed, context: run_panes_create(parsed),
    "panes archive": lambda parsed, context: run_panes_archive(parsed),
    "panes pin": lambda parsed, context: run_panes_pin(parsed, True),
    "panes unpin": lambda parsed, context: run_panes_pin(parsed, False),
    "panes rename": lambda parsed, context: run_panes_rename(parsed),
    "panes focus": lambda parsed, context: run_panes_focus(parsed),
    "panels list": lambda parsed, context: run_panels_list(parsed),
    "panels create": lambda parsed, context: run_panels_create(parsed),
    "panels open": lambda parsed, context: run_panels_open(parsed),
    "panels output": lambda parsed, context: run_panels_output(parsed),
    "panels input": lambda parsed, context: run_panels_input(parsed),
    "panels screen": lambda parsed, context: run_panels_screen(parsed),
    "panels submit": lambda parsed, context: run_panels_submit(parsed),
    "panels submit-composer": lambda parsed, context: run_panels_submit_composer(parsed),
    "panels wait": lambda parsed, context: run_panels_wait(parsed),
    "panels resume": lambda parsed, context: run_panels_resume(parsed),
    "panels last-message": lambda parsed, context: run_panels_last_message(parsed),
    "report": lambda parsed, context: run_report(parsed),
    "agents doctor": lambda parsed, context: run_agents_doctor(parsed),
    "panes adopt": lambda parsed, context: run_panes_adopt(parsed),
    "help": lambda parsed, context: print_help(parsed),
    "install": lambda parsed, context: install_or_update(parsed, context),
    "update": lambda parsed, context: install_or_update(parsed, context),
    "mcp": lambda parsed, context: run_unsupported_contract(parsed, context),
    "panes git-status": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes commit": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes push": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes pull": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes rebase-main": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes restore": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes squash-rebase": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes stash": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes stash-pop": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes soft-reset": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes fetch": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes run-script": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes stop-script": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "panes move": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "folders list": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "folders create": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "links open": lambda parsed, context: run_daemon_action(parsed, contract_command(parsed.command)["daemonAction"]),
    "docs search": lambda parsed, context: run_unsupported_contract(parsed, context),
    "docs read": lambda parsed, context: run_unsupported_contract(parsed, context),
    "agents start": lambda parsed, context: run_unsupported_contract(parsed, context),
    "agents status": lambda parsed, context: run_unsupported_contract(parsed, context),
    "agents send": lambda parsed, context: run_unsupported_contract(parsed, context),
}
_contract_commands = {command["name"] for command in RUNPANE_CONTRACT["commands"]}
_missing_handlers = _contract_commands - COMMAND_HANDLERS.keys()
_unexpected_handlers = COMMAND_HANDLERS.keys() - _contract_commands
if _missing_handlers:
    raise RuntimeError(f"Missing command handlers: {', '.join(sorted(_missing_handlers))}")
if _unexpected_handlers:
    raise RuntimeError(f"Unexpected command handlers: {', '.join(sorted(_unexpected_handlers))}")
