"""`runpane secrets`: Pane secrets, handed out only by `secrets exec` to a child process's environment.

Nothing here prints, logs or puts a value in an error message. Mirrors packages/runpane/src/secrets.ts.
"""

from __future__ import annotations

import errno
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Mapping, Optional

from .daemon_actions import confirm_mutation
from .daemon_client import PaneDaemonClientError, invoke_daemon
from .notify import RunpaneError, describe_notify_result, notify_caller_fields

ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
NOT_FOUND_NEXT = "Run `runpane secrets request`, or open Pane on a desktop connected to this machine so it syncs."
UNAVAILABLE_NEXT = "Ask the person to save it in Pane under Settings > Secrets, then run your command with `runpane secrets exec`. Do not ask them to paste it into the chat."
WINDOWS = os.name == "nt"


def invalid(message: str, next_step: str) -> RunpaneError:
    return RunpaneError("SECRET_INVALID", message, next_step)


def refuse_teammate(action: str, env: Optional[Mapping[str, str]] = None) -> None:
    """Pane secrets are the owner's.

    Pane sets PANE_TEAMMATE_LOGIN on a teammate's `workspace exec`, and every secrets command
    refuses it before asking Pane for anything.
    """
    teammate = (os.environ if env is None else env).get("PANE_TEAMMATE_LOGIN")
    if not teammate:
        return
    raise RunpaneError(
        "SECRET_OWNER_REQUIRED",
        f"Only this computer's owner can use its Pane secrets, so {teammate} cannot {action}. Nothing was read or changed.",
        "Ask the owner to do it on their own devices.",
    )


def require_flag(parsed: Any, value: Optional[str], flag: str, outcome: str) -> str:
    if value and value.strip():
        return value
    raise invalid(f"runpane {parsed.command} requires {flag}. {outcome}", f"See the options with `runpane help {parsed.command}`.")


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))


def run_secrets_list(parsed: Any) -> int:
    refuse_teammate("list them")
    request = {} if parsed.project is None else {"project": parsed.project}
    result = invoke_daemon("runpane:secrets:list", [request], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
        return 0
    if not result["secrets"]:
        scope = "" if parsed.project is None else f" in project {parsed.project}"
        print(f"No Pane secrets{scope} on this machine yet.")
    for secret in result["secrets"]:
        print(f"{secret['project']}/{secret['name']}  set {secret['updatedAt']} on {secret['machine']}")
    storage = result.get("storage") or {}
    if storage.get("kind") == "file" and not storage.get("encrypted"):
        print("This machine has no OS keyring, so its secret values are stored unencrypted in a file only you can read.")
    return 0


def run_secrets_set(parsed: Any) -> int:
    refuse_teammate("save one")
    project = require_flag(parsed, parsed.project, "--project", "Nothing was saved.")
    name = require_flag(parsed, parsed.name, "--name", "Nothing was saved.")
    if sys.stdin.isatty():
        raise RunpaneError(
            "SECRET_STDIN_REQUIRED",
            "runpane secrets set reads the value from stdin, and stdin is a terminal. Nothing was saved.",
            f'Pipe the value in, such as `printf %s "$VALUE" | runpane secrets set --project {project} --name {name} --yes`. '
            "To have the person enter it, use Settings > Secrets in Pane or `runpane secrets request`.",
        )
    confirm_mutation(parsed)
    value = re.sub(r"\r?\n\Z", "", sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    if not value:
        raise invalid("The value on stdin is empty. Nothing was saved.", "Pipe the secret's value to `runpane secrets set`.")
    result = invoke_daemon("runpane:secrets:set", [{"project": project, "name": name, "value": value}], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
    else:
        secret = result["secret"]
        print(f"{'Replaced' if result.get('replaced') else 'Saved'} {secret['project']}/{secret['name']}")
    return 0


def run_secrets_delete(parsed: Any) -> int:
    refuse_teammate("delete one")
    project = require_flag(parsed, parsed.project, "--project", "Nothing was deleted.")
    name = require_flag(parsed, parsed.name, "--name", "Nothing was deleted.")
    confirm_mutation(parsed)
    result = invoke_daemon("runpane:secrets:delete", [{"project": project, "name": name}], pane_dir=parsed.pane_dir)
    if parsed.json:
        print_json(result)
    else:
        print(f"Deleted {result['deleted']['project']}/{result['deleted']['name']}")
    return 0


def is_reserved_target(name: str) -> bool:
    # Every case counts: secrets sync across platforms, and Windows reads Path as PATH.
    key = name.upper()
    return key in {"PATH", "WORKTREE_PATH"} or key.startswith("PANE_")


def check_targets(injections: List[Dict[str, Any]]) -> None:
    seen = set()
    for injection in injections:
        target, secret = injection["target"], injection["secret"]
        if not ENV_NAME.fullmatch(target):
            raise invalid(
                f'"{target}" is not a valid variable name: use letters, digits and underscores, not starting with a digit. Nothing was run.',
                "See the naming rules with `runpane help secrets`.",
            )
        if is_reserved_target(target):
            short = target[len("PANE_"):] if target.upper().startswith("PANE_") else target
            raise RunpaneError(
                "SECRET_RESERVED_NAME",
                f"{target} is set by Pane itself (PATH, WORKTREE_PATH and PANE_* are reserved), so runpane secrets exec does not set it. Nothing was run.",
                f"Inject it under another name, such as --env MY_{short}={secret}.",
            )
        key = target.upper() if WINDOWS else target
        if key in seen:
            raise invalid(f"{target} is set twice; give each variable one source. Nothing was run.", "Name each variable once across --only, --env and --file.")
        seen.add(key)


def requested_injections(parsed: Any) -> List[Dict[str, Any]]:
    """What --only, --env and --file ask for; empty means every secret in the project."""
    injections = [{"target": name, "secret": name, "file": False} for name in parsed.only or []]
    for mapping in parsed.env_args or []:
        match = re.fullmatch(r"([^=]+)=(.+)", mapping, re.DOTALL)
        if not match:
            raise invalid(
                f'--env must be VAR=NAME, such as --env STRIPE_API_KEY=STRIPE_SECRET_KEY; got "{mapping}". Nothing was run.',
                "Pass --env VAR=NAME to inject secret NAME as VAR.",
            )
        injections.append({"target": match.group(1), "secret": match.group(2), "file": False})
    for name in parsed.secret_files or []:
        injections.append({"target": name, "secret": name, "file": True})
    return injections


def resolve_secrets(parsed: Any, project: str, names: Optional[List[str]]) -> Dict[str, str]:
    request: Dict[str, Any] = {"project": project}
    if names is not None:
        request["names"] = names
    result = invoke_daemon("runpane:secrets:resolve", [request], pane_dir=parsed.pane_dir)
    values = result.get("values") if isinstance(result, dict) else None
    if not isinstance(values, dict):
        raise RunpaneError("SECRET_UNREADABLE", "Pane returned secrets in a form this runpane cannot read. Nothing was run.", "Compare the versions with `runpane doctor` and update the older one.")
    for name, value in values.items():
        if not isinstance(value, str):
            raise RunpaneError(
                "SECRET_UNREADABLE",
                f"Pane returned secret {name} in a form this runpane cannot read. Nothing was run.",
                "Compare the versions with `runpane doctor` and update the older one.",
            )
    return values


def run_secrets_exec(parsed: Any) -> int:
    """Starts the command with the secrets in its environment, passes stdio through, and returns its exit code."""
    refuse_teammate("run secrets exec")
    project = require_flag(parsed, parsed.project, "--project", "Nothing was run.")
    command = parsed.exec_command or []
    if not command:
        raise invalid("runpane secrets exec needs a command after --. Nothing was run.", f"Run `runpane secrets exec --project {project} -- <command>`.")
    requested = requested_injections(parsed)
    check_targets(requested)
    names = list(dict.fromkeys(item["secret"] for item in requested)) if requested else None
    values = resolve_secrets(parsed, project, names)
    injections = requested or [{"target": name, "secret": name, "file": False} for name in values]
    if not injections:
        raise RunpaneError("SECRET_NOT_FOUND", f"No secrets in project {project} on this machine yet. Nothing was run.", NOT_FOUND_NEXT)
    check_targets(injections)
    for injection in injections:
        if injection["secret"] not in values:
            raise RunpaneError("SECRET_NOT_FOUND", f"No secret {project}/{injection['secret']} on this machine yet. Nothing was run.", NOT_FOUND_NEXT)

    env = dict(os.environ)
    temp_dir: Optional[str] = None
    try:
        for injection in injections:
            target, secret = injection["target"], injection["secret"]
            if WINDOWS:
                for key in [key for key in env if key.upper() == target.upper()]:
                    del env[key]
            if not injection["file"]:
                env[target] = values[secret]
                continue
            if temp_dir is None:
                temp_dir = tempfile.mkdtemp(prefix="runpane-secrets-")
            file_path = os.path.join(temp_dir, secret)
            descriptor = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(values[secret])
            env[target] = file_path
        status = run_child(command, env)
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)
    if status < 0:
        # Re-raise a signal that ended the child only after its files are gone.
        signal.signal(-status, signal.SIG_DFL)
        os.kill(os.getpid(), -status)
    return status if status >= 0 else 1


def run_child(command: List[str], env: Mapping[str, str]) -> int:
    """Runs the child with signals forwarded the way the npm CLI does; a negative status is the signal that ended it."""
    # From a terminal, Ctrl-C and Ctrl-\ reach the child through the process group it shares with
    # this CLI, so forwarding them would deliver them twice. Without a terminal the child gets its
    # own group and every signal is forwarded once.
    own_group = not WINDOWS and not sys.stdin.isatty()
    args = windows_batch_command(command) or command
    try:
        child = subprocess.Popen(args, env=dict(env), start_new_session=own_group)
    except OSError as error:
        code = errno.errorcode.get(error.errno or 0, "unknown error")
        raise RunpaneError(
            "ERR_SECRETS_EXEC_FAILED",
            f"runpane secrets exec could not start {command[0]} ({code}). Nothing was run.",
            "Check that the command is installed and on PATH. For a shell command, run it through a shell: `-- sh -c '...'`, or `-- cmd /c ...` on Windows.",
        ) from None

    def forward(signum: int, _frame: Any) -> None:
        child.send_signal(signum)

    def interrupt(signum: int, _frame: Any) -> None:
        if own_group:
            child.send_signal(signum)

    handlers = {"SIGINT": interrupt, "SIGQUIT": interrupt, "SIGTERM": forward, "SIGHUP": forward}
    previous = {}
    for name, handler in handlers.items():
        number = getattr(signal, name, None)
        if number is not None:
            previous[number] = signal.signal(number, handler)
    try:
        status = child.wait()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    return status


def windows_batch_command(command: List[str]) -> Optional[str]:
    """On Windows, npm, pnpm and npx are .cmd shims, which only cmd.exe can run.

    Finds the command the way cmd.exe does (the current directory, then PATH, with each PATHEXT
    extension) and, for a .cmd or .bat file, returns a cmd.exe command line that passes every
    argument literally.
    """
    if not WINDOWS:
        return None
    found = shutil.which(command[0])
    if not found or not found.lower().endswith((".cmd", ".bat")):
        return None
    words = [found, *command[1:]]
    if any(re.search(r'[%!"\x00-\x1f\x7f]', word) for word in words):
        raise invalid(
            f'{command[0]} is a Windows batch file, and cmd.exe cannot pass %, !, " or control characters in its arguments literally. Nothing was run.',
            "Remove those characters from the arguments, or run the program the batch file starts directly.",
        )
    return 'cmd.exe /d /s /c "' + " ".join(f'"{word}"' for word in words) + '"'


def run_secrets_request(parsed: Any, env: Optional[Mapping[str, str]] = None) -> int:
    """A secret Notify card. The answer is saved by Pane; only saved or declined comes back."""
    refuse_teammate("ask for one", env)
    outcome = "Nothing was shown to the person."
    project = require_flag(parsed, parsed.project, "--project", outcome)
    name = require_flag(parsed, parsed.name, "--name", outcome)
    title = require_flag(parsed, parsed.title, "--title", outcome)
    reason = require_flag(parsed, parsed.reason, "--reason", outcome)
    caller, timing = notify_caller_fields(os.environ if env is None else env, os.getcwd())
    request = {"ui": "secret", "title": title, "context": reason, "secret": {"project": project, "name": name}, **timing, "caller": caller}
    try:
        result = invoke_daemon("runpane:notify", [request], pane_dir=parsed.pane_dir, timeout_ms=math.inf)
    except PaneDaemonClientError as error:
        if error.connection_failure:
            reason_text = "Pane is not running."
        elif error.code == "ERR_UNKNOWN_CHANNEL":
            reason_text = "This Pane doesn't support notify yet."
        else:
            raise
        result = {"unavailable": reason_text, "next": UNAVAILABLE_NEXT}
    print(json.dumps(result, indent=2) if parsed.json else describe_notify_result(result))
    return 0
