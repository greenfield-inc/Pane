"""To-dos is experimental and off by default (T-39).

Settings > Advanced > Experimental > To-dos saves `todosEnabled` in `<pane-dir>/config.json`. While it
is off, `runpane todos ...` refuses, and help and agent-context carry no to-do text. `--todo` on notify,
report and agents start is still accepted (an agent with an older prompt keeps its question) and
dropped. Mirrors packages/runpane/src/todosFeature.ts.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Sequence

from .daemon_client import resolve_pane_directory
from .notify import RunpaneError

TODOS_DISABLED_CODE = "TODOS_DISABLED"
TODO_TEXT = re.compile(r"to-do|todos|--todo", re.IGNORECASE)
TODO_FLAG_USAGE = re.compile(r" \[--todo <T-n>\]")


def todos_enabled(pane_dir: str) -> bool:
    """Whether To-dos is on in this Pane directory; a missing or unreadable config counts as off."""
    try:
        with open(os.path.join(pane_dir, "config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(config, dict) and config.get("todosEnabled") is True


def todos_on(pane_dir: Optional[str] = None) -> bool:
    """The same, for `--pane-dir` (else PANE_DIR, else ~/.pane)."""
    return todos_enabled(resolve_pane_directory(pane_dir))


def todos_disabled_error() -> RunpaneError:
    return RunpaneError(
        TODOS_DISABLED_CODE,
        "To-dos is turned off in this Pane, so nothing was read or changed. Saved to-dos are kept.",
        "Turn it on in Settings > Advanced > Experimental > To-dos, then run this again.",
    )


def is_todo_command(name: str) -> bool:
    return name == "todos" or name.startswith("todos ")


def mentions_todos(text: str) -> bool:
    return TODO_TEXT.search(text) is not None


def without_todo_lines(lines: Sequence[str]) -> List[str]:
    """The lines with `[--todo <T-n>]` taken out of usage lines, and every line still about to-dos dropped."""
    stripped = (TODO_FLAG_USAGE.sub("", line) for line in lines)
    return [line for line in stripped if not mentions_todos(line)]


def without_todo_arguments(command: Dict[str, Any]) -> Dict[str, Any]:
    """An agent-context command without its `--todo` argument and its to-do examples and notes."""
    result = dict(command)
    result["arguments"] = [
        argument for argument in command["arguments"]
        if not mentions_todos(argument["name"]) and not mentions_todos(argument.get("description", ""))
    ]
    result["examples"] = without_todo_lines(command["examples"])
    if "notes" in command:
        result["notes"] = without_todo_lines(command["notes"])
    return result
