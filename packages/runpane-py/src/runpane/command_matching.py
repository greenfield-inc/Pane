from typing import List, Optional, Tuple

from .generated_contract import RUNPANE_CONTRACT

COMMAND_MATCHERS = sorted(
    ((command["name"], command["name"].split(" ")) for command in RUNPANE_CONTRACT["commands"]),
    key=lambda item: len(item[1]),
    reverse=True,
)
LOCAL_COMMANDS = {command["name"] for command in RUNPANE_CONTRACT["commands"] if command["localControl"]}


def match_command(args: List[str]) -> Optional[Tuple[str, List[str]]]:
    for command, tokens in COMMAND_MATCHERS:
        if args[:len(tokens)] == tokens:
            return command, tokens
    return None


def is_runpane_local_command(command: str) -> bool:
    return command in LOCAL_COMMANDS
