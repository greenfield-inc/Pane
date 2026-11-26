"""`runpane custom-commands`: a machine's saved launch commands, like the npm CLI's customCommands.ts.

The machine that answers edits its own list and picks the change up at once; update, remove and
reorder select an entry by its exact, case-sensitive name. `runpane workspace <machine> ...` forms
run through the Node CLI Pane installs, since this package has no workspace transport of its own.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .daemon_actions import confirm_mutation
from .daemon_client import PaneDaemonClientError, invoke_daemon, resolve_pane_directory
from .notify import RunpaneError
from .version import wrapper_version

RESUME_MODES = ("reported", "generated", "claude", "codex", "cursor")
SHORTCUT_NOTE = "Custom command keyboard shortcuts follow list order, so the moved entries now answer to different shortcut slots."
# The workspace forms this package hands to the Node CLI (D-8 plan, package 2).
DELEGATED_WORKSPACE_COMMANDS = (("custom-commands",), ("sessions", "create"))
BUNDLE_VERSION_PATTERN = re.compile(r"^// runpane-version (\S+)$", re.MULTILINE)


def run_custom_commands_list(parsed: Any) -> int:
    result = call("runpane:custom-commands:list", [], parsed)
    if parsed.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    commands = result.get("commands", [])
    if not commands:
        print("No custom commands on this machine. Add one with `runpane custom-commands add --name <name> --command <command> --yes`.")
        return 0
    for entry in commands:
        print(f"{entry.get('position')}. {entry.get('name')}")
        print(f"   command: {entry.get('command')}")
        resume = entry.get("resume")
        if resume:
            print(f"   resume mode: {resume.get('mode')}")
            print(f"   first launch template: {resume.get('initialTemplate')}")
            print(f"   resume template: {resume.get('resumeTemplate')}")
    return 0


def run_custom_commands_add(parsed: Any) -> int:
    name = required(parsed.name, "--name", "add", 'Pass the name the "+" menu shows with --name.')
    command = required(parsed.custom_command_text, "--command", "add", "Pass the command line to run with --command.")
    resume = resume_patch(parsed, "add")
    if resume is None and parsed.resume_mode == "none":
        raise invalid(
            "runpane custom-commands add takes --resume-mode none only on update; a new entry has no resume settings to clear.",
            "Leave out --resume-mode, or pass reported, generated, claude, codex or cursor.",
        )
    request: Dict[str, Any] = {"name": name, "command": command}
    if resume:
        request["resume"] = resume
    confirm_mutation(parsed)
    return report(parsed, call("runpane:custom-commands:add", [request], parsed))


def run_custom_commands_update(parsed: Any) -> int:
    request: Dict[str, Any] = {"name": selected(parsed, "update")}
    if parsed.name is not None:
        request["newName"] = parsed.name
    if parsed.custom_command_text is not None:
        request["command"] = parsed.custom_command_text
    if parsed.resume_mode == "none" or parsed.resume_mode is not None or parsed.initial_template is not None or parsed.resume_template is not None:
        request["resume"] = resume_patch(parsed, "update")
    if len(request) == 1:
        raise invalid(
            "runpane custom-commands update needs something to change. Nothing was changed.",
            "Pass --name, --command, --resume-mode, --initial-template or --resume-template.",
        )
    confirm_mutation(parsed)
    return report(parsed, call("runpane:custom-commands:update", [request], parsed))


def run_custom_commands_remove(parsed: Any) -> int:
    name = selected(parsed, "remove")
    confirm_mutation(parsed)
    return report(parsed, call("runpane:custom-commands:remove", [{"name": name}], parsed))


def run_custom_commands_reorder(parsed: Any) -> int:
    name = selected(parsed, "reorder")
    if parsed.position is None:
        raise invalid("runpane custom-commands reorder requires --to <position>. Nothing was changed.", "Pass the 1-based position the entry should end up at, such as --to 1.")
    if parsed.position < 1:
        raise invalid("--to must be 1 or more. Nothing was changed.", "Pass a position from 1 to the number of entries in `runpane custom-commands list`.")
    confirm_mutation(parsed)
    return report(parsed, call("runpane:custom-commands:reorder", [{"name": name, "position": parsed.position}], parsed))


def resume_patch(parsed: Any, verb: str) -> Optional[Dict[str, str]]:
    """The resume fields given, None for `--resume-mode none` or when no resume flag was passed."""
    mode, initial, resume = parsed.resume_mode, parsed.initial_template, parsed.resume_template
    if mode == "none":
        if initial is not None or resume is not None:
            raise invalid(
                f"runpane custom-commands {verb} takes --resume-mode none (which clears the resume settings) without template flags. Nothing was changed.",
                "Drop the template flags, or pick a resume mode.",
            )
        return None
    if mode is not None and mode not in RESUME_MODES:
        raise invalid(f'Unknown --resume-mode "{mode}". Nothing was changed.', f"Use one of: {', '.join([*RESUME_MODES, 'none'])}.")
    if mode is None and initial is None and resume is None:
        return None
    patch: Dict[str, str] = {}
    if mode is not None:
        patch["mode"] = mode
    if initial is not None:
        patch["initialTemplate"] = initial
    if resume is not None:
        patch["resumeTemplate"] = resume
    return patch


def selected(parsed: Any, verb: str) -> str:
    if not parsed.custom_command_name:
        raise invalid(
            f"runpane custom-commands {verb} needs the entry's exact name as its first word. Nothing was changed.",
            f'Run `runpane custom-commands list`, then `runpane custom-commands {verb} "<name>" ...`.',
        )
    return parsed.custom_command_name


def required(value: Optional[str], flag: str, verb: str, next_step: str) -> str:
    if not value or not value.strip():
        raise invalid(f"runpane custom-commands {verb} requires a non-blank {flag}. Nothing was changed.", next_step)
    return value


def invalid(message: str, next_step: str) -> RunpaneError:
    return RunpaneError("ERR_RUNPANE_INVALID_ARGUMENT", message, next_step)


def report(parsed: Any, result: Dict[str, Any]) -> int:
    moved = result.get("action") == "moved" and result.get("changed")
    if parsed.json:
        print(json.dumps({**result, "note": SHORTCUT_NOTE} if moved else result, indent=2, ensure_ascii=False))
        return 0
    quoted = json.dumps(result.get("name"), ensure_ascii=False)
    action, count = result.get("action"), result.get("count")
    if action == "added":
        print(f"Added {quoted} at position {result.get('position')} of {count}.")
    elif action == "updated":
        print(f"Updated {quoted} (position {result.get('position')} of {count}).")
    elif action == "removed":
        print(f"Removed {quoted}; {count} custom command{'' if count == 1 else 's'} left.")
    elif not result.get("changed"):
        print(f"{quoted} is already at position {result.get('position')}; nothing changed.")
    else:
        print(f"Moved {quoted} from position {result.get('previousPosition')} to {result.get('position')}. {SHORTCUT_NOTE}")
    return 0


def call(channel: str, args: List[Any], parsed: Any) -> Dict[str, Any]:
    """A daemon call; a Pane too old for these commands gets a clear upgrade step instead of an unknown channel."""
    try:
        return invoke_daemon(channel, args, pane_dir=parsed.pane_dir)
    except PaneDaemonClientError as error:
        if error.code != "ERR_UNKNOWN_CHANNEL":
            raise
        raise RunpaneError(
            "ERR_PANE_TOO_OLD",
            f"This Pane does not have custom-commands, which needs Pane {wrapper_version()} or newer. Nothing was changed.",
            "Update Pane on that machine with `runpane update`, restart it, then run the command again.",
        ) from error


def delegated_workspace_argv(argv: List[str]) -> bool:
    """Whether argv is `workspace <machine> custom-commands ...` or `workspace <machine> sessions create ...`."""
    words = [word for word in argv]
    while words and (words[0] == "--pane-dir" or words[0].startswith("--pane-dir=")):
        words = words[2:] if words[0] == "--pane-dir" else words[1:]
    if len(words) < 3 or words[0] != "workspace" or words[1].startswith("-"):
        return False
    rest = words[2:]
    return any(tuple(rest[: len(prefix)]) == prefix for prefix in DELEGATED_WORKSPACE_COMMANDS)


def run_through_node_cli(argv: List[str], pane_dir: Optional[str] = None) -> int:
    """Runs argv, unchanged and without a shell, in the Node CLI that Pane installs in its data directory."""
    bin_dir = Path(resolve_pane_directory(pane_dir)) / "bin"
    needed = wrapper_version()
    cli = managed_node_cli(bin_dir)
    if cli is None or version_tuple(cli["version"]) < version_tuple(needed):
        found = f"runpane {cli['version']}" if cli else "no runpane CLI"
        raise RunpaneError(
            "ERR_RUNPANE_NODE_CLI_MISSING",
            f"`runpane workspace <machine> {' '.join(argv[2:4])}` runs through the runpane CLI Pane installs, and {bin_dir} has {found}; it needs runpane {needed} or newer. Nothing was run.",
            "Update Pane on this computer (`runpane update`) and open it once, or install the npm CLI (`npm i -g runpane`) and run the same command with it.",
        )
    env = {**os.environ, "RUNPANE_NO_HANDOFF": "1", "PANE_DIR": str(bin_dir.parent)}
    return subprocess.run([cli["runtime"], cli["entrypoint"], *argv], env=env, check=False).returncode


def managed_node_cli(bin_dir: Path) -> Optional[Dict[str, str]]:
    """The CLI Pane keeps in its bin directory: a `runpane update` pin, or the bundled runpane.cjs run by Node."""
    try:
        override = bin_dir / "runpane-override.json"
        if override.is_file():
            pin = json.loads(override.read_text(encoding="utf-8"))
            if all(isinstance(pin.get(key), str) and pin.get(key) for key in ("version", "entrypoint", "runtime")) and Path(pin["entrypoint"]).is_file():
                return {"version": pin["version"], "entrypoint": pin["entrypoint"], "runtime": pin["runtime"]}
            return None
        entrypoint = bin_dir / "runpane.cjs"
        node = shutil.which("node")
        if not entrypoint.is_file() or not node:
            return None
        with entrypoint.open(encoding="utf-8") as handle:
            match = BUNDLE_VERSION_PATTERN.search(handle.read(4096))
        return {"version": match.group(1), "entrypoint": str(entrypoint), "runtime": node} if match else None
    except (OSError, ValueError):
        return None


def version_tuple(version: str) -> tuple:
    return tuple(int(part) for part in re.findall(r"\d+", version.split("-")[0])[:3])
