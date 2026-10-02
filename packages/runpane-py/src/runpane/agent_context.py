from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Optional, Sequence

from .generated_contract import RUNPANE_CONTRACT

MAX_COMMAND_CANDIDATES = 5


def run_agent_context(parsed: Any) -> int:
    if parsed.context_command is not None and find_command_detail(parsed.context_command) is None:
        return print_unknown_command(parsed.context_command, parsed.json)
    result = build_agent_context_result(parsed.context_command)
    if parsed.json:
        print(json.dumps(result, indent=2))
        return 0

    if result["mode"] == "brief":
        print(render_brief(result))
    else:
        print(render_command_detail(result["command"]))
    return 0


def build_agent_context_result(command_name: Optional[str] = None) -> Dict[str, Any]:
    if command_name:
        return {
            "ok": True,
            "mode": "command",
            "source": "runpane-contract",
            "command": get_command_detail(command_name),
        }

    brief = RUNPANE_CONTRACT["agentContext"]["brief"]
    return {
        "ok": True,
        "mode": "brief",
        "source": "runpane-contract",
        "summary": brief["summary"],
        "rules": brief["rules"],
        "tools": brief["tools"],
        "detailCommand": brief["detailCommand"],
    }


def find_command_detail(command_name: str) -> Optional[Dict[str, Any]]:
    normalized = normalize_command_name(command_name)
    for command in RUNPANE_CONTRACT["agentContext"]["commands"].values():
        if normalize_command_name(command["name"]) == normalized:
            return command
    return None


def get_command_detail(command_name: str) -> Dict[str, Any]:
    detail = find_command_detail(command_name)
    if detail is not None:
        return detail

    raise ValueError(f"Unknown runpane command: {command_name}. Expected one of: {', '.join(command_names())}")


def print_unknown_command(command_name: str, as_json: bool) -> int:
    error = {
        "ok": False,
        "code": "unknown_command",
        "message": f"Unknown runpane command: {command_name}. Run `runpane agent-context --json` to list every command.",
        "candidates": rank_command_candidates(command_name),
    }
    if as_json:
        print(json.dumps(error, indent=2))
    else:
        print(error["message"], file=sys.stderr)
        if error["candidates"]:
            print(f"Closest commands: {', '.join(error['candidates'])}", file=sys.stderr)
    return 2


def rank_command_candidates(query: str, names: Optional[Sequence[str]] = None) -> List[str]:
    """Command names closest to `query`: most shared words, then smallest edit distance, then alphabetical."""
    query_words = command_words(query)
    query_word_set = set(query_words)
    query_compact = "".join(query_words)
    ranked = []
    for name in command_names() if names is None else names:
        words = command_words(name)
        compact = "".join(words)
        shared = len({word for word in words if word in query_word_set})
        distance = edit_distance(query_compact, compact)
        if shared > 0 or distance <= max(2, len(compact) // 3):
            ranked.append((-shared, distance, name))
    ranked.sort()
    return [name for _, _, name in ranked[:MAX_COMMAND_CANDIDATES]]


def command_words(command_name: str) -> List[str]:
    without_binary = re.sub(r"^runpane\s+", "", command_name.strip(), flags=re.IGNORECASE)
    return [word for word in re.split(r"[._\s-]+", without_binary.lower()) if word]


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row in range(1, len(left) + 1):
        current = [row]
        for column in range(1, len(right) + 1):
            substitution = previous[column - 1] + (0 if left[row - 1] == right[column - 1] else 1)
            current.append(min(previous[column] + 1, current[column - 1] + 1, substitution))
        previous = current
    return previous[len(right)]


def normalize_command_name(command_name: str) -> str:
    without_binary = re.sub(r"^runpane\s+", "", command_name.strip(), flags=re.IGNORECASE)
    return re.sub(r"[._\s-]+", "", without_binary.lower())


def render_brief(result: Dict[str, Any]) -> str:
    lines = [
        RUNPANE_CONTRACT["agentContext"]["brief"]["title"],
        "",
        result["summary"],
        "",
        "Rules:",
    ]
    lines.extend(f"- {rule}" for rule in result["rules"])
    lines.extend(["", "Tools:"])
    for tool in result["tools"]:
        lines.append(f"- {tool['name']}: {tool['summary']}")
        lines.append(f"  Args: {', '.join(tool['arguments'])}")
    lines.extend(["", f"Detailed definitions: {result['detailCommand']}"])
    return "\n".join(lines)


def render_command_detail(command: Dict[str, Any]) -> str:
    lines = [
        f"runpane {command['name']}",
        "",
        command["summary"],
        "",
        "Details:",
        command["details"],
        "",
        f"Requires Pane daemon: {'yes' if command.get('requiresPaneDaemon') else 'no'}",
        f"Mutates Pane state: {'yes' if command.get('mutates') else 'no'}",
        "",
        "Arguments:",
    ]

    if not command["arguments"]:
        lines.append("- none")
    else:
        for argument in command["arguments"]:
            value = f" {argument['value']}" if argument.get("value") else ""
            required = "required" if argument["required"] else "optional"
            lines.append(f"- {argument['name']}{value} ({required}): {argument['description']}")

    lines.extend(["", "Examples:"])
    lines.extend(f"- {example}" for example in command["examples"])

    if command.get("jsonSchemas"):
        lines.extend(["", "JSON schemas:"])
        lines.extend(f"- {schema}" for schema in command["jsonSchemas"])

    if command.get("notes"):
        lines.extend(["", "Notes:"])
        lines.extend(f"- {note}" for note in command["notes"])

    return "\n".join(lines)


def command_names() -> List[str]:
    return sorted(
        command["name"]
        for command in RUNPANE_CONTRACT["agentContext"]["commands"].values()
    )
