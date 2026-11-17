"""`runpane link <link>`: redeems a one-time link through this computer's Pane (mirrors the npm wrapper's pairingLink.ts)."""
import json
import sys
from typing import Any, List, Optional, TextIO

from .daemon_client import invoke_daemon
from .notify import RunpaneError


def names(items: List[str]) -> str:
    return "".join(items) if len(items) < 2 else f"{', '.join(items[:-1])} and {items[-1]}"


def run_link(parsed: Any, stdin: Optional[TextIO] = None, stdout: Optional[TextIO] = None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    link = (parsed.pairing_link or "").strip()
    if not link:
        raise RunpaneError(
            "ERR_RUNPANE_INVALID_ARGUMENT",
            "runpane link needs the link to redeem. Nothing was linked.",
            "Copy a link in Pane on the other computer (Add a device › Computer), then run: runpane link '<link>'",
        )
    preview = invoke_daemon("relay:link-preview", [{"link": link}], pane_dir=parsed.pane_dir)
    maker = str(preview["maker"])
    if preview.get("needsConfirm") and not parsed.yes:
        joins = (
            f"This link joins your computers ({names(list(preview['here']))}) with {maker}'s "
            f"({names(list(preview['makerGroup']))}), and each can then run agents on the others."
            if preview["here"]
            else f"This link lets {maker}'s computers ({names(list(preview['makerGroup']))}) run agents on this computer, "
            "and this computer run agents on them."
        )
        if parsed.json or not (stdin.isatty() and stdout.isatty()):
            raise RunpaneError(
                "ERR_LINK_NEEDS_CONFIRM",
                f"{joins} This shell cannot ask you to confirm, so nothing was linked and the link is still unused.",
                "Run it again with --yes to join them: runpane link '<link>' --yes",
            )
        stdout.write(f"{joins}\nLink with {maker}? [y/N] ")
        stdout.flush()
        if stdin.readline().strip().lower() not in {"y", "yes"}:
            raise RunpaneError(
                "ERR_LINK_CANCELLED",
                "You did not confirm, so nothing was linked. The link is still unused.",
                "Run runpane link again to link them, or let another device use the link.",
            )
    linked = [str(name) for name in invoke_daemon("relay:redeem-link", [{"link": link}], pane_dir=parsed.pane_dir)["linked"]]
    if parsed.json:
        stdout.write(json.dumps({"ok": True, "maker": maker, "linked": linked}, indent=2) + "\n")
    else:
        stdout.write(f"Linked with {names(linked or [maker])}. List them with: runpane workspace list\n")
    return 0
