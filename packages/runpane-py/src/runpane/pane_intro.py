from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Sequence

from .generated_contract import RUNPANE_CONTRACT


def approvals_enabled(pane_dir: str) -> bool:
    """Approvals (`notify.enabled` in `<pane-dir>/config.json`) is on unless the person turned it off."""
    try:
        with open(os.path.join(pane_dir, "config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return True
    notify = config.get("notify") if isinstance(config, dict) else None
    return not (isinstance(notify, dict) and notify.get("enabled") is False)


def _render_part(part: Dict[str, Any], approvals: bool) -> str:
    choice = part["approvals"]["on" if approvals else "off"]
    return " ".join(choice if sentence == "{approvals}" else sentence for sentence in part["sentences"])


def pane_intro(pane_dir: str) -> Dict[str, Any]:
    """What Pane is and how to work in it, people first, rendered for this person's Approvals setting."""
    intro = RUNPANE_CONTRACT["agentContext"]["intro"]
    approvals = approvals_enabled(pane_dir)
    return {
        "humans": _render_part(intro["humans"], approvals),
        "agents": _render_part(intro["agents"], approvals),
        "approvals": approvals,
    }


def render_pane_intro(intro: Dict[str, Any], rules: Optional[Sequence[str]] = None) -> str:
    """The intro as text: each part under its title, then the working rules when given."""
    parts = RUNPANE_CONTRACT["agentContext"]["intro"]
    lines: List[str] = [f"{parts['humans']['title']}:", intro["humans"], "", f"{parts['agents']['title']}:", intro["agents"]]
    if rules:
        lines += ["", "Working in Pane:", *[f"- {rule}" for rule in rules]]
    return "\n".join(lines)
